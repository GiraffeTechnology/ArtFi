package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// A proof may expire before a wallet submits it. Renew the independent source's
// attestation on the original issuance request; never release its asset binding
// or infer that a missing receipt makes a second issuance safe.
func (service *rwaService) renewMintEvidence(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Evidence rwaSourceEvidence `json:"evidence"`
	}
	if err := decodeJSON(r, &input); err != nil {
		service.writeRWAError(w, r, adminError(400, "A signed source evidence envelope is required."))
		return
	}
	id := r.PathValue("intentID")
	if !adminIDPattern.MatchString(id) {
		service.writeRWAError(w, r, adminError(404, "Mint intent not found."))
		return
	}
	if service.db == nil {
		service.writeRWAError(w, r, adminError(503, "Durable evidence renewal is unavailable."))
		return
	}
	service.mintMu.Lock()
	defer service.mintMu.Unlock()
	tx, err := service.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	defer tx.Rollback()
	intent, err := loadGroundedMintTx(r.Context(), tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		service.writeRWAError(w, r, adminError(404, "Mint intent not found."))
		return
	}
	if err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	prior, next := intent.SourceEvidence, input.Evidence
	if prior == nil || !sameMintEvidenceBinding(*prior, next) {
		service.writeRWAError(w, r, adminError(409, "Renewal must preserve the original source, underlying asset, enforceable rights, mode and issuance context."))
		return
	}
	contextHash := mintEvidenceContext(intent.ChainID, intent.RegistryAddress, intent.RequestID, intent.Recipient, intent.MetadataSHA256, intent.MetadataURI)
	if err = service.lockActiveEvidence(r.Context(), tx, next, contextHash, "fractional"); err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	var locked string
	err = tx.QueryRowContext(r.Context(), "SELECT intent_id FROM rwa_mint_intents WHERE intent_id=? FOR UPDATE", id).Scan(&locked)
	if errors.Is(err, sql.ErrNoRows) {
		service.writeRWAError(w, r, adminError(404, "Mint intent not found."))
		return
	}
	if err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	intent, err = loadGroundedMintTx(r.Context(), tx, id)
	if err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	if err = service.renewGroundedMintTx(r.Context(), tx, intent, next); err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	if err = tx.Commit(); err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	service.mu.Lock()
	service.intents[id] = intent
	service.mu.Unlock()
	writeJSON(w, 200, intent)
}

func sameMintEvidenceBinding(a, b rwaSourceEvidence) bool {
	return a.SourceID == b.SourceID && a.SourceAssetID == b.SourceAssetID && a.UnderlyingAssetID == b.UnderlyingAssetID && a.Section == b.Section && a.Mode == b.Mode && a.Rights == b.Rights && strings.EqualFold(a.ContextHash, b.ContextHash)
}

// Caller holds the active-evidence lock before the immutable intent row lock.
// Both normal create replay and explicit renewal share the same durable update.
func (service *rwaService) renewGroundedMintTx(ctx context.Context, tx *sql.Tx, intent *mintIntent, next rwaSourceEvidence) error {
	prior := intent.SourceEvidence
	if prior == nil || !sameMintEvidenceBinding(*prior, next) {
		return adminError(409, "Renewal must preserve the original source, underlying asset, enforceable rights, mode and issuance context.")
	}
	if hashJSON(*prior) == hashJSON(next) {
		return nil
	}
	body, _ := json.Marshal(next)
	if _, err := tx.ExecContext(ctx, "UPDATE rwa_mint_evidence SET evidence_id=UNHEX(?),evidence=?,verified_at=? WHERE intent_id=?", next.EvidenceID[2:], body, service.now(), intent.IntentID); err != nil {
		return groundedMintConflict(err)
	}
	actor, resource := sha256.Sum256([]byte(next.SourceID)), sha256.Sum256([]byte(intent.IntentID))
	audit, _ := json.Marshal(map[string]any{"intentId": intent.IntentID, "requestId": intent.RequestID, "previousEvidence": prior, "renewedEvidence": next})
	if _, err := tx.ExecContext(ctx, `INSERT INTO security_audit_log(occurred_at,actor_hash,action,resource_type,resource_hash,decision,request_id,metadata) VALUES(?,?,'rwa.mint.evidence-renewed','rwa_source_evidence',?,'allow',?,?)`, service.now(), actor[:], resource[:], newRequestID(), audit); err != nil {
		return err
	}
	intent.SourceEvidence = &next
	converted := next.contractEvidence()
	intent.ContractEvidence = &converted
	return nil
}
