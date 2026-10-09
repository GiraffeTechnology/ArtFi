package httpapi

// Approved-source evidence is independent of ArtFi's operator and moderation
// roles. The application only verifies externally issued public-key signatures;
// it has no source-signing key and never manufactures an authenticity claim.
import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const evidenceDomain = "ArtFi approved-source evidence v1"
const revocationDomain = "ArtFi approved-source revocation v1"
const zeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000"
const zeroAddress = "0x0000000000000000000000000000000000000000"

var sourceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var rwaSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)

type approvedRWASource struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	PublicKeyX     string `json:"publicKeyX"`
	PublicKeyY     string `json:"publicKeyY"`
	Mode           string `json:"mode"`
	RegistryBacked bool   `json:"registryBacked"`
	Disabled       bool   `json:"disabled"`
}
type rwaRegistryRecord struct {
	Reference  string `json:"reference"`
	Version    string `json:"version"`
	ObservedAt int64  `json:"observedAt"`
}
type rwaSourceEvidence struct {
	SourceID          string             `json:"sourceId"`
	SourceAssetID     string             `json:"sourceAssetId"`
	EvidenceID        string             `json:"evidenceId"`
	UnderlyingAssetID string             `json:"underlyingAssetId"`
	Section           string             `json:"section"`
	Mode              string             `json:"mode"`
	SourceReference   string             `json:"sourceReference"`
	EvidenceSHA256    string             `json:"evidenceSha256"`
	Rights            string             `json:"rights"`
	RegistryRecord    *rwaRegistryRecord `json:"registryRecord,omitempty"`
	ValidFrom         int64              `json:"validFrom"`
	ValidUntil        int64              `json:"validUntil"`
	ContextHash       string             `json:"contextHash"`
	SignatureR        string             `json:"signatureR"`
	SignatureS        string             `json:"signatureS"`
}
type rwaContractEvidence struct {
	SourceIDHash    string `json:"sourceIdHash"`
	SourceAssetHash string `json:"sourceAssetHash"`
	AssetKey        string `json:"assetKey"`
	EvidenceID      string `json:"evidenceId"`
	ClaimHash       string `json:"claimHash"`
	ValidFrom       int64  `json:"validFrom"`
	ValidUntil      int64  `json:"validUntil"`
	ModeHash        string `json:"modeHash"`
	SectionHash     string `json:"sectionHash"`
}
type rwaRevocation struct {
	SourceID   string `json:"sourceId"`
	EvidenceID string `json:"evidenceId"`
	RevokedAt  int64  `json:"revokedAt"`
	Reason     string `json:"reason"`
	Mode       string `json:"mode"`
	SignatureR string `json:"signatureR"`
	SignatureS string `json:"signatureS"`
}

type rwaGrounding struct {
	Status          string             `json:"status"`
	Mode            string             `json:"mode"`
	SourceID        string             `json:"sourceId"`
	SourceName      string             `json:"sourceName"`
	SourceKind      string             `json:"sourceKind"`
	SourceReference string             `json:"sourceReference"`
	SourceAssetID   string             `json:"sourceAssetId"`
	EvidenceID      string             `json:"evidenceId"`
	EvidenceSHA256  string             `json:"evidenceSha256"`
	ValidFrom       string             `json:"validFrom"`
	ValidUntil      string             `json:"validUntil"`
	VerifiedAt      string             `json:"verifiedAt"`
	RegistryBacked  bool               `json:"registryBacked"`
	RegistryRecord  *rwaRegistryRecord `json:"registryRecord,omitempty"`
}

type rwaGroundingPolicy struct {
	sources map[string]approvedRWASource
	mode    string
}

func groundingPolicyFromEnv() rwaGroundingPolicy {
	mode := strings.TrimSpace(os.Getenv("ARTFI_RWA_EVIDENCE_MODE"))
	if mode == "" {
		mode = "LIVE"
	}
	if mode != "LIVE" && (mode != "TEST_ONLY" || os.Getenv("ARTFI_ENV") != "test") {
		return rwaGroundingPolicy{sources: map[string]approvedRWASource{}}
	}
	sources, err := parseRWASources(os.Getenv("ARTFI_RWA_APPROVED_SOURCES_JSON"), mode)
	if err != nil {
		sources = map[string]approvedRWASource{}
	}
	return rwaGroundingPolicy{sources: sources, mode: mode}
}
func parseRWASources(value, mode string) (map[string]approvedRWASource, error) {
	result := make(map[string]approvedRWASource)
	if strings.TrimSpace(value) == "" {
		return result, nil
	}
	var input []approvedRWASource
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if len(value) > 65536 || decoder.Decode(&input) != nil || len(input) > 100 {
		return nil, errors.New("invalid approved-source configuration")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("invalid approved-source configuration")
	}
	for _, source := range input {
		if !sourceIDPattern.MatchString(source.ID) || !adminText(source.Name, 2, 160) || source.Mode != mode || (source.Kind != "registry" && source.Kind != "warehouse" && source.Kind != "custody" && source.Kind != "certificate" && source.Kind != "provenance") || result[source.ID].ID != "" {
			return nil, errors.New("invalid or duplicate approved source")
		}
		if _, err := source.publicKey(); err != nil {
			return nil, err
		}
		result[source.ID] = source
	}
	return result, nil
}
func (s approvedRWASource) publicKey() (*ecdsa.PublicKey, error) {
	x, okx := hexInteger(s.PublicKeyX)
	y, oky := hexInteger(s.PublicKeyY)
	if !okx || !oky || !elliptic.P256().IsOnCurve(x, y) {
		return nil, errors.New("invalid source public key")
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, nil
}
func hexInteger(s string) (*big.Int, bool) {
	if !txHashPattern.MatchString(s) {
		return nil, false
	}
	v, ok := new(big.Int).SetString(s[2:], 16)
	return v, ok
}
func hashText(s string) string { h := sha256.Sum256([]byte(s)); return "0x" + hex.EncodeToString(h[:]) }
func hashJSON(v any) string    { p, _ := json.Marshal(v); return hashText(string(p)) }
func evidenceClaimHash(e rwaSourceEvidence) string {
	// This struct is the canonical signed claim, independent of JSON input ordering.
	return hashJSON(struct {
		Reference string             `json:"sourceReference"`
		Document  string             `json:"evidenceSha256"`
		Rights    string             `json:"rights"`
		Section   string             `json:"section"`
		Registry  *rwaRegistryRecord `json:"registryRecord,omitempty"`
	}{e.SourceReference, strings.ToLower(e.EvidenceSHA256), e.Rights, e.Section, e.RegistryRecord})
}
func (e rwaSourceEvidence) contractEvidence() rwaContractEvidence {
	return rwaContractEvidence{hashText(e.SourceID), hashText(e.SourceAssetID), hashText(e.UnderlyingAssetID), strings.ToLower(e.EvidenceID), evidenceClaimHash(e), e.ValidFrom, e.ValidUntil, hashText(e.Mode), hashText(e.Section)}
}
func abiHash(words ...string) string {
	var payload []byte
	for _, word := range words {
		decoded, err := hex.DecodeString(strings.TrimPrefix(word, "0x"))
		if err != nil || len(decoded) > 32 {
			return ""
		}
		var padded [32]byte
		copy(padded[32-len(decoded):], decoded)
		payload = append(payload, padded[:]...)
	}
	return hashText(string(payload))
}
func intWord(v int64) string {
	if v < 0 {
		return "invalid"
	}
	return fmt.Sprintf("%064x", v)
}
func sourceEvidenceDigest(e rwaSourceEvidence) string {
	c := e.contractEvidence()
	return abiHash(hashText(evidenceDomain), c.SourceIDHash, c.SourceAssetHash, c.AssetKey, c.EvidenceID, c.ClaimHash, e.ContextHash, intWord(e.ValidFrom), intWord(e.ValidUntil), c.ModeHash, c.SectionHash)
}
func mintEvidenceContext(chainID int, registry, requestID, recipient, metadataHash, metadataURI string) string {
	return abiHash(intWord(int64(chainID)), registry, requestID, recipient, metadataHash, hashText(metadataURI))
}
func validPublicEvidenceURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && len(value) <= 512
}
func validNonzeroHash(value string) bool {
	return txHashPattern.MatchString(value) && !strings.EqualFold(value, zeroHash)
}
func validNonzeroAddress(value string) bool {
	return addressPattern.MatchString(value) && !strings.EqualFold(value, zeroAddress)
}
func verifyP256(source approvedRWASource, digest, rValue, sValue string) bool {
	key, err := source.publicKey()
	r, okr := hexInteger(rValue)
	s, oks := hexInteger(sValue)
	hash, errh := hex.DecodeString(strings.TrimPrefix(digest, "0x"))
	if err != nil || errh != nil || !okr || !oks || len(hash) != 32 {
		return false
	}
	half := new(big.Int).Rsh(new(big.Int).Set(elliptic.P256().Params().N), 1)
	return s.Sign() > 0 && s.Cmp(half) <= 0 && ecdsa.Verify(key, hash, r, s)
}
func (p rwaGroundingPolicy) verify(e rwaSourceEvidence, contextHash, section string, now time.Time, allowHistorical bool) error {
	source, ok := p.sources[e.SourceID]
	if !ok || source.Disabled || source.Mode != p.mode || e.Mode != p.mode {
		return adminError(422, "The evidence source is not currently approved for this environment.")
	}
	if !adminText(e.SourceAssetID, 1, 256) || !adminText(e.UnderlyingAssetID, 3, 256) || !validNonzeroHash(e.EvidenceID) || !validNonzeroHash(e.EvidenceSHA256) || !adminText(e.SourceReference, 1, 512) || !adminText(e.Rights, 20, 4000) || e.Section != section || (section != "whole" && section != "fractional") || e.ContextHash != contextHash || !validNonzeroHash(contextHash) || e.ValidFrom <= 0 || e.ValidUntil <= e.ValidFrom {
		return adminError(422, "The source evidence does not bind the exact asset, rights, model and operation.")
	}
	if source.RegistryBacked {
		r := e.RegistryRecord
		if r == nil || !adminText(r.Reference, 1, 512) || !adminText(r.Version, 1, 128) || r.ObservedAt <= 0 || r.ObservedAt > e.ValidFrom {
			return adminError(422, "A source-signed registry reference, version and observation time are required.")
		}
	} else if e.RegistryRecord != nil {
		return adminError(422, "This source is not approved as a registry-backed source.")
	}
	if !verifyP256(source, sourceEvidenceDigest(e), e.SignatureR, e.SignatureS) {
		return adminError(422, "The approved source signature is invalid.")
	}
	if !allowHistorical && (now.Unix() < e.ValidFrom || now.Unix() >= e.ValidUntil) {
		return adminError(409, "The approved-source evidence is not currently valid.")
	}
	return nil
}
func (service *rwaService) evidenceRevoked(ctx context.Context, e rwaSourceEvidence) (bool, error) {
	if service.db == nil {
		return false, service.persistenceRequirement()
	}
	rows, err := service.db.QueryContext(ctx, "SELECT evidence_id FROM rwa_source_revocations WHERE source_id=? AND evidence_id=UNHEX(?)", e.SourceID, strings.TrimPrefix(e.EvidenceID, "0x"))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	revoked := rows.Next()
	return revoked, rows.Err()
}
func (service *rwaService) verifyActiveEvidence(ctx context.Context, e rwaSourceEvidence, contextHash, section string) error {
	if err := service.grounding.verify(e, contextHash, section, service.now(), false); err != nil {
		return err
	}
	revoked, err := service.evidenceRevoked(ctx, e)
	if err != nil {
		return err
	}
	if revoked {
		return adminError(409, "The approved source revoked this evidence.")
	}
	return nil
}
func (service *rwaService) groundingStatus(e rwaSourceEvidence, contextHash, section string, revoked bool, verifiedAt time.Time) rwaGrounding {
	source := service.grounding.sources[e.SourceID]
	if source.Name == "" {
		source.Name = e.SourceID
	}
	if source.Kind == "" {
		source.Kind = "unconfigured"
	}
	source.RegistryBacked = e.RegistryRecord != nil
	g := rwaGrounding{Status: "verified", Mode: e.Mode, SourceID: e.SourceID, SourceName: source.Name, SourceKind: source.Kind, SourceReference: e.SourceReference, SourceAssetID: e.SourceAssetID, EvidenceID: e.EvidenceID, EvidenceSHA256: e.EvidenceSHA256, ValidFrom: time.Unix(e.ValidFrom, 0).UTC().Format(time.RFC3339), ValidUntil: time.Unix(e.ValidUntil, 0).UTC().Format(time.RFC3339), VerifiedAt: verifiedAt.UTC().Format(time.RFC3339), RegistryBacked: source.RegistryBacked, RegistryRecord: e.RegistryRecord}
	if err := service.grounding.verify(e, contextHash, section, service.now(), true); err != nil {
		g.Status = "source-unavailable"
	} else if revoked {
		g.Status = "revoked"
	} else if service.now().Unix() < e.ValidFrom {
		g.Status = "not-yet-valid"
	} else if service.now().Unix() >= e.ValidUntil {
		g.Status = "expired"
	}
	return g
}
func (service *rwaService) revokeRWAEvidence(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var input rwaRevocation
	if decodeJSON(r, &input) != nil {
		writeProblem(w, r, 400, "Invalid revocation", "A signed source revocation is required.")
		return
	}
	source, ok := service.grounding.sources[input.SourceID]
	digest := abiHash(hashText(revocationDomain), hashText(input.SourceID), input.EvidenceID, intWord(input.RevokedAt), hashText(input.Reason), hashText(input.Mode))
	// Disabled sources may still revoke previously issued evidence. Revocation is
	// permanent; removing a trust root also renders its claims unavailable.
	if !ok || input.Mode != service.grounding.mode || source.Mode != input.Mode || !validNonzeroHash(input.EvidenceID) || input.RevokedAt <= 0 || input.RevokedAt > service.now().Unix() || !adminText(input.Reason, 3, 500) || !verifyP256(source, digest, input.SignatureR, input.SignatureS) {
		writeProblem(w, r, 422, "Invalid source revocation", "The revocation must be signed by its configured evidence source.")
		return
	}
	if service.db == nil {
		writeProblem(w, r, 503, "Source persistence unavailable", "No revocation was confirmed.")
		return
	}
	tx, err := service.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		writeProblem(w, r, 503, "Source persistence unavailable", "No revocation was confirmed.")
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `INSERT IGNORE INTO rwa_evidence_locks(source_id,evidence_id,created_at) VALUES (?,UNHEX(?),?)`, input.SourceID, strings.TrimPrefix(input.EvidenceID, "0x"), service.now())
	if err == nil {
		var id []byte
		err = tx.QueryRowContext(r.Context(), `SELECT evidence_id FROM rwa_evidence_locks WHERE source_id=? AND evidence_id=UNHEX(?) FOR UPDATE`, input.SourceID, strings.TrimPrefix(input.EvidenceID, "0x")).Scan(&id)
	}
	if err != nil {
		writeProblem(w, r, 503, "Source persistence unavailable", "No revocation was confirmed.")
		return
	}
	body, _ := json.Marshal(input)
	result, err := tx.ExecContext(r.Context(), `INSERT IGNORE INTO rwa_source_revocations(source_id,evidence_id,revoked_at,envelope) VALUES (?,UNHEX(?),?,?)`, input.SourceID, strings.TrimPrefix(input.EvidenceID, "0x"), time.Unix(input.RevokedAt, 0).UTC(), body)
	if err == nil {
		var affected int64
		affected, err = result.RowsAffected()
		if err == nil && affected > 0 {
			actor := sha256.Sum256([]byte(input.SourceID))
			resource := sha256.Sum256([]byte(input.EvidenceID))
			_, err = tx.ExecContext(r.Context(), `INSERT INTO security_audit_log(occurred_at,actor_hash,action,resource_type,resource_hash,decision,request_id,metadata) VALUES(?,?, 'rwa.evidence.revoked','rwa_source_evidence',?,'allow',?,?)`, service.now(), actor[:], resource[:], newRequestID(), body)
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		writeProblem(w, r, 503, "Source persistence unavailable", "No revocation was confirmed.")
		return
	}
	writeJSON(w, 200, map[string]any{"sourceId": input.SourceID, "evidenceId": input.EvidenceID, "status": "revoked"})
}

// Keep canonical strict decode separate from payload text. No imported evidence
// document is fetched, and no URL in an attestation can redirect server traffic.
