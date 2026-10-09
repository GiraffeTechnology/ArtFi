package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	mysql "github.com/go-sql-driver/mysql"
	"net/http"
	"strings"
	"time"
)

type rwaMetadataPreparation struct {
	RequestID       string `json:"requestId"`
	Recipient       string `json:"recipient"`
	RegistryAddress string `json:"registryAddress"`
	ChainID         int    `json:"chainId"`
	MetadataURI     string `json:"metadataUri"`
	MetadataSHA256  string `json:"metadataSha256"`
	ContextHash     string `json:"contextHash"`
	Executable      bool   `json:"executable"`
	Status          string `json:"status"`
	keyHash         string
}

func (service *rwaService) writeRWAError(w http.ResponseWriter, r *http.Request, err error) {
	var p *adminProblem
	if errors.As(err, &p) {
		writeProblem(w, r, p.status, "RWA request rejected", p.detail)
		return
	}
	writeProblem(w, r, 503, "RWA evidence unavailable", "Durable approved-source evidence could not be verified. No mint or activation was authorized.")
}
func (service *rwaService) prepareRWAMetadata(w http.ResponseWriter, r *http.Request) {
	_, draft, err := service.prepareRWARequest(r)
	if err != nil {
		service.writeRWAError(w, r, err)
		return
	}
	writeJSON(w, 200, draft)
}
func (service *rwaService) prepareRWARequest(r *http.Request) (mintIntentRequest, *rwaMetadataPreparation, error) {
	var input mintIntentRequest
	if !service.writeEnabled() {
		return input, nil, adminError(503, "Hoodi registry, object storage and durable operator write configuration are required.")
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) < 16 || len(key) > 128 {
		return input, nil, adminError(400, "Idempotency-Key must contain 16–128 characters.")
	}
	if err := decodeJSON(r, &input); err != nil {
		return input, nil, adminError(400, err.Error())
	}
	if !validNonzeroAddress(input.Recipient) || !validMetadataFields(input) {
		return input, nil, adminError(422, "Recipient and required RWA metadata failed validation.")
	}
	upload, err := service.readUpload(r.Context(), input.UploadID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return input, nil, err
	}
	if upload == nil || !upload.Completed {
		return input, nil, adminError(409, "The image must be uploaded and digest-verified first.")
	}
	metadata := map[string]any{"name": input.Name, "description": input.Description, "image": service.publicURL(upload.ObjectKey), "attributes": []map[string]any{{"trait_type": "Artist", "value": input.Artist}, {"trait_type": "Year", "value": input.Year}, {"trait_type": "Medium", "value": input.Medium}, {"trait_type": "Location", "value": input.Location}}, "artfi": map[string]any{"schemaVersion": 1, "imageSha256": upload.SHA256, "chainId": hoodiChainID}}
	if service.grounding.mode == "TEST_ONLY" {
		metadata["artfiTestPayload"] = map[string]any{"mode": "TEST_ONLY", "labels": []string{"TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"}}
	}
	body, _ := json.Marshal(metadata)
	digest := sha256.Sum256(body)
	metadataHash := hex.EncodeToString(digest[:])
	objectKey := "rwa/metadata/" + metadataHash + ".json"
	if err := service.store.Put(r.Context(), objectKey, body, "application/json", metadataHash); err != nil {
		return input, nil, adminError(502, "The immutable metadata could not be persisted.")
	}
	unsigned := input
	unsigned.Evidence = nil
	payload, _ := json.Marshal(unsigned)
	payloadHash := sha256.Sum256(payload)
	keyHash := sha256.Sum256([]byte(key))
	requestHash := sha256.Sum256(append(keyHash[:], payloadHash[:]...))
	draft := &rwaMetadataPreparation{RequestID: "0x" + hex.EncodeToString(requestHash[:]), Recipient: input.Recipient, RegistryAddress: service.config.registryAddress, ChainID: hoodiChainID, MetadataURI: service.publicURL(objectKey), MetadataSHA256: "0x" + metadataHash, Executable: false, Status: "awaiting-approved-source-evidence", keyHash: hex.EncodeToString(keyHash[:])}
	draft.ContextHash = mintEvidenceContext(draft.ChainID, draft.RegistryAddress, draft.RequestID, draft.Recipient, draft.MetadataSHA256, draft.MetadataURI)
	return input, draft, nil
}
func (service *rwaService) persistGroundedMint(ctx context.Context, r *http.Request, intent *mintIntent) (*mintIntent, bool, error) {
	e := *intent.SourceEvidence
	contextHash := mintEvidenceContext(intent.ChainID, intent.RegistryAddress, intent.RequestID, intent.Recipient, intent.MetadataSHA256, intent.MetadataURI)
	if service.db == nil {
		if err := service.persistenceRequirement(); err != nil {
			return nil, false, err
		}
		// Isolated, in-memory tests still enforce authenticity and uniqueness.
		service.mu.RLock()
		defer service.mu.RUnlock()
		for _, prior := range service.intents {
			if prior.SourceEvidence != nil && prior.SourceEvidence.UnderlyingAssetID == e.UnderlyingAssetID {
				return nil, false, adminError(409, "This authenticated underlying asset already has an issuance intent.")
			}
		}
		return intent, true, nil
	}
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	if err = service.lockActiveEvidence(ctx, tx, e, contextHash, "fractional"); err != nil {
		return nil, false, err
	}
	var id string
	err = tx.QueryRowContext(ctx, "SELECT intent_id FROM rwa_mint_intents WHERE idempotency_key_hash=UNHEX(?) FOR UPDATE", intent.idempotencyKeyHash).Scan(&id)
	if err == nil {
		loaded, err := loadGroundedMintTx(ctx, tx, id)
		if err != nil {
			return nil, false, err
		}
		if !strings.EqualFold(loaded.RequestID, intent.RequestID) {
			return nil, false, adminError(409, "This idempotency key was used for a different immutable mint request.")
		}
		if err = service.renewGroundedMintTx(ctx, tx, loaded, e); err != nil {
			return nil, false, err
		}
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return loaded, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	createdAt, err := time.Parse(time.RFC3339, intent.CreatedAt)
	if err != nil {
		return nil, false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO rwa_mint_intents(intent_id,idempotency_key_hash,payload_hash,request_id,upload_id,recipient,registry_address,chain_id,metadata_uri,metadata_sha256,status,created_at) VALUES(?,UNHEX(?),UNHEX(?),UNHEX(?),?,?,?,?,?,UNHEX(?),'prepared',?)`, intent.IntentID, intent.idempotencyKeyHash, intent.payloadHash, intent.RequestID[2:], intent.uploadID, intent.Recipient, intent.RegistryAddress, intent.ChainID, intent.MetadataURI, intent.MetadataSHA256[2:], createdAt)
	if err != nil {
		return nil, false, groundedMintConflict(err)
	}
	body, _ := json.Marshal(e)
	_, err = tx.ExecContext(ctx, `INSERT INTO rwa_mint_evidence(intent_id,source_id,evidence_id,asset_key,source_asset_key,evidence,verified_at) VALUES(?,?,UNHEX(?),UNHEX(?),UNHEX(?),?,?)`, intent.IntentID, e.SourceID, e.EvidenceID[2:], hashText(e.UnderlyingAssetID)[2:], hashText(e.SourceID + "\x00" + e.SourceAssetID)[2:], body, createdAt)
	if err != nil {
		return nil, false, groundedMintConflict(err)
	}
	actor, resource := sha256.Sum256([]byte(e.SourceID)), sha256.Sum256([]byte(intent.IntentID))
	audit, _ := json.Marshal(map[string]any{"intentId": intent.IntentID, "requestId": intent.RequestID, "sourceId": e.SourceID, "evidenceId": e.EvidenceID, "underlyingAssetId": e.UnderlyingAssetID, "contextHash": e.ContextHash, "mode": e.Mode})
	_, err = tx.ExecContext(ctx, `INSERT INTO security_audit_log(occurred_at,actor_hash,action,resource_type,resource_hash,decision,request_id,metadata) VALUES(?,?,'rwa.mint.prepared','rwa_source_evidence',?,'allow',?,?)`, createdAt, actor[:], resource[:], newRequestID(), audit)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return nil, false, err
	}
	return intent, true, nil
}
func groundedMintConflict(err error) error {
	var me *mysql.MySQLError
	if errors.As(err, &me) && me.Number == 1062 {
		return adminError(409, "The issuance key, source evidence or underlying asset is already committed to a mint.")
	}
	return err
}
func loadGroundedMintTx(ctx context.Context, tx *sql.Tx, id string) (*mintIntent, error) {
	var body []byte
	var created time.Time
	i := &mintIntent{}
	err := tx.QueryRowContext(ctx, `SELECT i.intent_id,CONCAT('0x',LOWER(HEX(i.request_id))),i.recipient,i.registry_address,i.chain_id,i.metadata_uri,CONCAT('0x',LOWER(HEX(i.metadata_sha256))),i.status,COALESCE(i.transaction_hash,''),i.created_at,LOWER(HEX(i.payload_hash)),LOWER(HEX(i.idempotency_key_hash)),i.upload_id,e.evidence FROM rwa_mint_intents i JOIN rwa_mint_evidence e ON e.intent_id=i.intent_id WHERE i.intent_id=?`, id).Scan(&i.IntentID, &i.RequestID, &i.Recipient, &i.RegistryAddress, &i.ChainID, &i.MetadataURI, &i.MetadataSHA256, &i.Status, &i.TransactionHash, &created, &i.payloadHash, &i.idempotencyKeyHash, &i.uploadID, &body)
	if err != nil {
		return nil, err
	}
	var evidence rwaSourceEvidence
	if err = json.Unmarshal(body, &evidence); err != nil {
		return nil, err
	}
	i.SourceEvidence = &evidence
	c := evidence.contractEvidence()
	i.ContractEvidence = &c
	i.CreatedAt = created.UTC().Format(time.RFC3339)
	i.ContractFunction = "createAssetWithEvidence(bytes32,address,string,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,bytes32,bytes32),bytes32,bytes32)"
	i.ContractArguments = []string{i.RequestID, i.Recipient, i.MetadataURI, i.MetadataSHA256}
	return i, nil
}
func (service *rwaService) hydrateMintEvidence(ctx context.Context) error {
	rows, err := service.db.QueryContext(ctx, "SELECT intent_id,evidence FROM rwa_mint_evidence")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var body []byte
		if err = rows.Scan(&id, &body); err != nil {
			return err
		}
		i := service.intents[id]
		if i == nil {
			return errors.New("source evidence references missing mint")
		}
		var e rwaSourceEvidence
		if err = json.Unmarshal(body, &e); err != nil {
			return err
		}
		i.SourceEvidence = &e
		c := e.contractEvidence()
		i.ContractEvidence = &c
		i.ContractFunction = "createAssetWithEvidence(bytes32,address,string,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,bytes32,bytes32),bytes32,bytes32)"
	}
	return rows.Err()
}

// A native source-verified issuance or an external source-activated receipt can
// provide the underlying identity before fractions have been created.
func (service *rwaService) requireGroundedUnderlying(ctx context.Context, collection, token string) error {
	if service.db == nil {
		return adminError(503, "Durable approved-source underlying bindings are unavailable.")
	}
	items, err := service.readCatalogRows(ctx, "c.chain_id=? AND LOWER(c.collection_address)=? AND c.token_id=?", hoodiChainID, strings.ToLower(collection), token)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Grounding.Status == "verified" {
			return nil
		}
	}
	rows, err := service.db.QueryContext(ctx, `SELECT e.evidence,CONCAT('0x',LOWER(HEX(i.request_id))),i.recipient,CONCAT('0x',LOWER(HEX(i.metadata_sha256))),i.registry_address,i.metadata_uri FROM rwa_mint_evidence e JOIN rwa_mint_intents i ON i.intent_id=e.intent_id JOIN chain_events c ON c.chain_id=i.chain_id AND LOWER(c.contract_address)=LOWER(i.registry_address) AND c.event_name='AssetCreated' AND c.confirmed=TRUE AND c.removed=FALSE AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.requestId')))=CONCAT('0x',LOWER(HEX(i.request_id))) WHERE LOWER(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.collectionAddress')))=? AND JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.tokenId'))=?`, strings.ToLower(collection), token)
	if err != nil {
		return err
	}
	defer rows.Close()
	type candidate struct {
		proof       rwaSourceEvidence
		contextHash string
	}
	proofs := []candidate{}
	for rows.Next() {
		var body []byte
		var requestID, recipient, metadata, registry, metadataURI string
		if err = rows.Scan(&body, &requestID, &recipient, &metadata, &registry, &metadataURI); err != nil {
			return err
		}
		var e rwaSourceEvidence
		if json.Unmarshal(body, &e) != nil {
			return errors.New("invalid issuance source evidence")
		}
		proofs = append(proofs, candidate{e, mintEvidenceContext(hoodiChainID, registry, requestID, recipient, metadata, metadataURI)})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, p := range proofs {
		if err := service.verifyActiveEvidence(ctx, p.proof, p.contextHash, "fractional"); err == nil {
			return nil
		}
	}
	return adminError(409, "No current approved-source evidence binds this underlying collection and token. Confirm its guarded issuance or activate its source-verified catalog record first.")
}

func (service *rwaService) readGroundedMint(ctx context.Context, id string) (*mintIntent, error) {
	if !adminIDPattern.MatchString(id) {
		return nil, sql.ErrNoRows
	}
	if service.db == nil {
		service.mu.RLock()
		defer service.mu.RUnlock()
		if i := service.intents[id]; i != nil {
			copy := *i
			return &copy, nil
		}
		return nil, sql.ErrNoRows
	}
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	return loadGroundedMintTx(ctx, tx, id)
}

func (service *rwaService) checkMintKeyConflict(ctx context.Context, keyHash, requestID string) error {
	if service.db == nil {
		service.mu.RLock()
		defer service.mu.RUnlock()
		if prior := service.intents[service.intentByKey[keyHash]]; prior != nil && !strings.EqualFold(prior.RequestID, requestID) {
			return adminError(409, "This idempotency key was already used for a different mint payload.")
		}
		return nil
	}
	rows, err := service.db.QueryContext(ctx, "SELECT CONCAT('0x',LOWER(HEX(request_id))) FROM rwa_mint_intents WHERE idempotency_key_hash=UNHEX(?)", keyHash)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		var stored string
		if err = rows.Scan(&stored); err != nil {
			return err
		}
		if !strings.EqualFold(stored, requestID) {
			return adminError(409, "This idempotency key was already used for a different mint payload.")
		}
	}
	return rows.Err()
}
