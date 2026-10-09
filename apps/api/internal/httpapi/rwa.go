package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	hoodiChainID   = 560048
	maxUploadBytes = 10 << 20
)

var (
	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	txHashPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
)

type objectStore interface {
	Put(context.Context, string, []byte, string, string) error
}

type rwaConfig struct {
	registryAddress     string
	vaultFactoryAddress string
	publicBaseURL       string
}

type uploadSession struct {
	ID          string
	ObjectKey   string
	FileName    string
	ContentType string
	SHA256      string
	Size        int64
	Completed   bool
	CreatedAt   time.Time
}

type mintIntent struct {
	SourceEvidence     *rwaSourceEvidence   `json:"sourceEvidence,omitempty"`
	ContractEvidence   *rwaContractEvidence `json:"contractEvidence,omitempty"`
	IntentID           string               `json:"intentId"`
	RequestID          string               `json:"requestId"`
	Recipient          string               `json:"recipient"`
	RegistryAddress    string               `json:"registryAddress"`
	ChainID            int                  `json:"chainId"`
	MetadataURI        string               `json:"metadataUri"`
	MetadataSHA256     string               `json:"metadataSha256"`
	ContractFunction   string               `json:"contractFunction"`
	ContractArguments  []string             `json:"contractArguments"`
	Status             string               `json:"status"`
	TransactionHash    string               `json:"transactionHash,omitempty"`
	CreatedAt          string               `json:"createdAt"`
	payloadHash        string
	uploadID           string
	idempotencyKeyHash string
}

type rwaService struct {
	grounding rwaGroundingPolicy
	mintMu    sync.Mutex

	mu                   sync.RWMutex
	config               rwaConfig
	store                objectStore
	uploads              map[string]*uploadSession
	intents              map[string]*mintIntent
	intentByKey          map[string]string
	vaultIntents         map[string]*vaultIntent
	vaultIntentByKey     map[string]string
	now                  func() time.Time
	db                   persistenceDB
	cache                cacheStore
	requireDB            bool
	indexerKeyHash       [32]byte
	indexerEnabled       bool
	operatorKeyHash      [32]byte
	operatorEnabled      bool
	requireOperator      bool
	marketplaceSources   map[string]struct{}
	openseaAPIKey        string
	externalTradeEnabled bool
	marketHTTPClient     *http.Client
	openseaAPIBaseURL    string
}

type uploadIntentRequest struct {
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
}

type mintIntentRequest struct {
	Evidence    *rwaSourceEvidence `json:"evidence,omitempty"`
	UploadID    string             `json:"uploadId"`
	Recipient   string             `json:"recipient"`
	Name        string             `json:"name"`
	Artist      string             `json:"artist"`
	Year        int                `json:"year"`
	Medium      string             `json:"medium"`
	Location    string             `json:"location"`
	Description string             `json:"description"`
}

type submissionRequest struct {
	TransactionHash string `json:"transactionHash"`
}

type memoryObjectStore struct {
	mu      sync.RWMutex
	objects map[string][]byte
}

type disabledObjectStore struct{}

func newRWAServiceFromEnv() *rwaService {
	config := rwaConfig{
		registryAddress:     strings.TrimSpace(os.Getenv("ARTFI_RWA_REGISTRY_ADDRESS")),
		vaultFactoryAddress: strings.TrimSpace(os.Getenv("ARTFI_VAULT_FACTORY_ADDRESS")),
		publicBaseURL:       strings.TrimRight(strings.TrimSpace(os.Getenv("ARTFI_OBJECT_PUBLIC_BASE_URL")), "/"),
	}
	store, err := newS3ObjectStoreFromEnv()
	if err != nil {
		store = disabledObjectStore{}
	}
	service := newRWAService(config, store)
	service.requireDB = true
	service.requireOperator = true
	service.marketplaceSources = parseMarketplaceSources(os.Getenv("ARTFI_MARKETPLACE_ALLOWLIST"))
	// Public-chain and marketplace egress is allowed only from the SIN execution zone.
	// CTYun backend processes therefore stay fail-closed even if a key is injected by mistake.
	if strings.TrimSpace(os.Getenv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE")) == "sin" {
		service.openseaAPIKey = strings.TrimSpace(os.Getenv("OPENSEA_API_KEY"))
		service.externalTradeEnabled = strings.EqualFold(strings.TrimSpace(os.Getenv("ARTFI_EXTERNAL_TRADE_ENABLED")), "true")
	} else {
		service.marketHTTPClient = nil
	}
	if operatorToken := strings.TrimSpace(os.Getenv("ARTFI_OPERATOR_BEARER_TOKEN")); operatorToken != "" {
		service.operatorKeyHash = sha256.Sum256([]byte(operatorToken))
		service.operatorEnabled = true
	}
	if indexerKey := strings.TrimSpace(os.Getenv("ARTFI_INDEXER_SHARED_KEY")); indexerKey != "" {
		service.indexerKeyHash = sha256.Sum256([]byte(indexerKey))
		service.indexerEnabled = true
	}
	service.attachPersistence(strings.TrimSpace(os.Getenv("MYSQL_DSN")))
	service.attachCache(strings.TrimSpace(os.Getenv("REDIS_URL")))
	return service
}

func newRWAService(config rwaConfig, store objectStore) *rwaService {
	return &rwaService{
		config:             config,
		grounding:          groundingPolicyFromEnv(),
		store:              store,
		uploads:            make(map[string]*uploadSession),
		intents:            make(map[string]*mintIntent),
		intentByKey:        make(map[string]string),
		vaultIntents:       make(map[string]*vaultIntent),
		vaultIntentByKey:   make(map[string]string),
		marketplaceSources: map[string]struct{}{"opensea": {}},
		marketHTTPClient:   &http.Client{Timeout: 12 * time.Second},
		openseaAPIBaseURL:  "https://api.opensea.io",
		now:                func() time.Time { return time.Now().UTC() },
	}
}

func newMemoryObjectStore() *memoryObjectStore {
	return &memoryObjectStore{objects: make(map[string][]byte)}
}

func (service *rwaService) writeEnabled() bool {
	return addressPattern.MatchString(service.config.registryAddress) &&
		validatePublicBaseURL(service.config.publicBaseURL) &&
		service.store != nil && !errors.Is(service.storeStatus(), errStoreDisabled) &&
		(!service.requireDB || service.db != nil) &&
		(!service.requireOperator || service.operatorEnabled)
}

func (service *rwaService) storeStatus() error {
	if _, disabled := service.store.(disabledObjectStore); disabled {
		return errStoreDisabled
	}
	return nil
}

func (service *rwaService) createUploadIntent(writer http.ResponseWriter, request *http.Request) {
	if !service.writeEnabled() {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Write path unavailable", "Hoodi source-verifying registry and object storage configuration are required.")
		return
	}

	var input uploadIntentRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid upload intent", err.Error())
		return
	}
	input.SHA256 = strings.ToLower(strings.TrimSpace(input.SHA256))
	input.FileName = safeFileName(input.FileName)
	if input.FileName == "" || !allowedContentType(input.ContentType) || input.Size <= 0 || input.Size > maxUploadBytes || !sha256Pattern.MatchString(input.SHA256) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid upload metadata", "Use a PNG, JPEG, or WebP file up to 10 MiB with a lowercase SHA-256 digest.")
		return
	}

	uploadID := randomID()
	session := &uploadSession{
		ID:          uploadID,
		ObjectKey:   fmt.Sprintf("rwa/images/%s/%s", input.SHA256, input.FileName),
		FileName:    input.FileName,
		ContentType: input.ContentType,
		SHA256:      input.SHA256,
		Size:        input.Size,
		CreatedAt:   service.now(),
	}
	service.mu.Lock()
	service.uploads[uploadID] = session
	service.mu.Unlock()
	if err := service.persistUpload(request.Context(), session); err != nil {
		service.mu.Lock()
		delete(service.uploads, uploadID)
		service.mu.Unlock()
		writeProblem(writer, request, http.StatusServiceUnavailable, "Persistence unavailable", "The upload intent could not be recorded durably.")
		return
	}

	writeJSON(writer, http.StatusCreated, map[string]any{
		"uploadId":        uploadID,
		"uploadUrl":       "/v1/uploads/" + uploadID,
		"method":          http.MethodPut,
		"expiresAt":       session.CreatedAt.Add(15 * time.Minute).Format(time.RFC3339),
		"maxBytes":        maxUploadBytes,
		"requiredHeaders": map[string]string{"Content-Type": input.ContentType, "Content-SHA256": input.SHA256},
	})
}

func (service *rwaService) uploadObject(writer http.ResponseWriter, request *http.Request) {
	session, err := service.readUpload(request.Context(), request.PathValue("uploadID"))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeProblem(writer, request, 503, "Persistence unavailable", "The upload intent could not be read from durable storage.")
		return
	}
	if session == nil {
		writeProblem(writer, request, http.StatusNotFound, "Upload not found", "The upload intent does not exist.")
		return
	}
	if service.now().After(session.CreatedAt.Add(15 * time.Minute)) {
		writeProblem(writer, request, http.StatusGone, "Upload expired", "Create a new upload intent.")
		return
	}
	if request.Header.Get("Content-Type") != session.ContentType || strings.ToLower(request.Header.Get("Content-SHA256")) != session.SHA256 {
		writeProblem(writer, request, http.StatusBadRequest, "Upload headers mismatch", "Content-Type and Content-SHA256 must match the upload intent.")
		return
	}

	data, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxUploadBytes+1))
	if err != nil || int64(len(data)) != session.Size || len(data) > maxUploadBytes {
		writeProblem(writer, request, http.StatusBadRequest, "Upload size mismatch", "The payload size must match the upload intent and remain within 10 MiB.")
		return
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != session.SHA256 {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Upload digest mismatch", "The payload does not match the declared SHA-256 digest.")
		return
	}
	if detected := http.DetectContentType(data); detected != session.ContentType {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Upload type mismatch", "The payload signature does not match the declared image content type.")
		return
	}
	if err := service.store.Put(request.Context(), session.ObjectKey, data, session.ContentType, session.SHA256); err != nil {
		writeProblem(writer, request, http.StatusBadGateway, "Object storage failure", "The validated object could not be persisted.")
		return
	}

	if err := service.persistUploadCompletion(request.Context(), session.ID); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Persistence unavailable", "The verified upload could not be marked complete durably.")
		return
	}
	service.mu.Lock()
	session.Completed = true
	service.uploads[session.ID] = session
	service.mu.Unlock()
	writer.WriteHeader(http.StatusNoContent)
}

func (service *rwaService) createMintIntent(writer http.ResponseWriter, request *http.Request) {
	service.mintMu.Lock()
	defer service.mintMu.Unlock()
	input, draft, err := service.prepareRWARequest(request)
	if err != nil {
		service.writeRWAError(writer, request, err)
		return
	}
	payloadHash := strings.TrimPrefix(hashJSON(input), "0x")
	if err := service.checkMintKeyConflict(request.Context(), draft.keyHash, draft.RequestID); err != nil {
		service.writeRWAError(writer, request, err)
		return
	}
	if input.Evidence == nil {
		writeProblem(writer, request, 422, "Approved-source evidence required", "Metadata and registrar authorization do not establish real-asset correspondence. Prepare the metadata commitment and supply an approved source's signed evidence.")
		return
	}
	contextHash := mintEvidenceContext(hoodiChainID, service.config.registryAddress, draft.RequestID, input.Recipient, draft.MetadataSHA256, draft.MetadataURI)
	if err := service.verifyActiveEvidence(request.Context(), *input.Evidence, contextHash, "fractional"); err != nil {
		service.writeRWAError(writer, request, err)
		return
	}
	service.mu.RLock()
	existing := service.intents[service.intentByKey[draft.keyHash]]
	service.mu.RUnlock()
	if existing != nil && service.db == nil {
		if !strings.EqualFold(existing.RequestID, draft.RequestID) {
			writeProblem(writer, request, 409, "Idempotency conflict", "This key already binds a different mint request or evidence claim.")
			return
		}
		if existing.SourceEvidence == nil || hashJSON(*existing.SourceEvidence) != hashJSON(*input.Evidence) {
			service.writeRWAError(writer, request, adminError(503, "Durable evidence renewal is unavailable."))
			return
		}
		writeJSON(writer, 200, existing)
		return
	}
	proof := *input.Evidence
	contractEvidence := proof.contractEvidence()
	intent := &mintIntent{IntentID: randomID(), RequestID: draft.RequestID, Recipient: input.Recipient, RegistryAddress: service.config.registryAddress, ChainID: hoodiChainID, MetadataURI: draft.MetadataURI, MetadataSHA256: draft.MetadataSHA256, ContractFunction: "createAssetWithEvidence(bytes32,address,string,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,bytes32,bytes32),bytes32,bytes32)", ContractArguments: []string{draft.RequestID, input.Recipient, draft.MetadataURI, draft.MetadataSHA256}, SourceEvidence: &proof, ContractEvidence: &contractEvidence, Status: "prepared", CreatedAt: service.now().Format(time.RFC3339), payloadHash: payloadHash, uploadID: input.UploadID, idempotencyKeyHash: draft.keyHash}
	stored, created, err := service.persistGroundedMint(request.Context(), request, intent)
	if err != nil {
		service.writeRWAError(writer, request, err)
		return
	}
	service.mu.Lock()
	service.intents[stored.IntentID] = stored
	service.intentByKey[draft.keyHash] = stored.IntentID
	service.mu.Unlock()
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, stored)
}

func (service *rwaService) getMintIntent(writer http.ResponseWriter, request *http.Request) {
	intent, err := service.readGroundedMint(request.Context(), request.PathValue("intentID"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeProblem(writer, request, 404, "Mint intent not found", "No source-verified mint intent matches the requested identifier.")
		} else {
			service.writeRWAError(writer, request, err)
		}
		return
	}
	if intent.SourceEvidence == nil {
		writeProblem(writer, request, 409, "Legacy unverified intent", "This metadata-only intent has no approved-source evidence and cannot authorize guarded issuance.")
		return
	}
	if intent.TransactionHash == "" {
		if err := service.verifyActiveEvidence(request.Context(), *intent.SourceEvidence, mintEvidenceContext(intent.ChainID, intent.RegistryAddress, intent.RequestID, intent.Recipient, intent.MetadataSHA256, intent.MetadataURI), "fractional"); err != nil {
			service.writeRWAError(writer, request, err)
			return
		}
	}
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) recordSubmission(writer http.ResponseWriter, request *http.Request) {
	var input submissionRequest
	if err := decodeJSON(request, &input); err != nil || !txHashPattern.MatchString(input.TransactionHash) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid transaction hash", "Use a 32-byte 0x-prefixed transaction hash.")
		return
	}
	intent, err := service.readGroundedMint(request.Context(), request.PathValue("intentID"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeProblem(writer, request, 404, "Mint intent not found", "No source-verified mint intent matches this identifier.")
		} else {
			service.writeRWAError(writer, request, err)
		}
		return
	}
	if intent.TransactionHash != "" && !strings.EqualFold(intent.TransactionHash, input.TransactionHash) {
		writeProblem(writer, request, http.StatusConflict, "Submission conflict", "A different transaction is already attached to this intent.")
		return
	}
	if err := service.persistSubmission(request.Context(), intent.IntentID, input.TransactionHash); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Persistence unavailable", "The transaction submission could not be recorded durably.")
		return
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	intent.TransactionHash = input.TransactionHash
	intent.Status = "submitted"
	service.intents[intent.IntentID] = intent
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) publicURL(objectKey string) string {
	return service.config.publicBaseURL + "/" + strings.TrimLeft(objectKey, "/")
}

func (store *memoryObjectStore) Put(_ context.Context, key string, data []byte, _ string, _ string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.objects[key] = bytes.Clone(data)
	return nil
}

var errStoreDisabled = errors.New("object store disabled")

func (disabledObjectStore) Put(context.Context, string, []byte, string, string) error {
	return errStoreDisabled
}

func allowedContentType(value string) bool {
	return value == "image/png" || value == "image/jpeg" || value == "image/webp"
}

func safeFileName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value != path.Base(value) || strings.ContainsAny(value, `\\/`) {
		return ""
	}
	value = regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(value, "-")
	if len(value) > 120 {
		return ""
	}
	return value
}

func validMetadataFields(input mintIntentRequest) bool {
	return len(strings.TrimSpace(input.Name)) >= 2 && len(input.Name) <= 120 &&
		len(strings.TrimSpace(input.Artist)) >= 2 && len(input.Artist) <= 120 &&
		input.Year >= 1000 && input.Year <= time.Now().UTC().Year()+1 &&
		len(strings.TrimSpace(input.Medium)) >= 2 && len(input.Medium) <= 160 &&
		len(strings.TrimSpace(input.Location)) >= 2 && len(input.Location) <= 160 &&
		len(strings.TrimSpace(input.Description)) >= 20 && len(input.Description) <= 2000
}

func decodeJSON(request *http.Request, value any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("request body must be a valid JSON object with known fields")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request body must contain exactly one JSON object")
	}
	return nil
}

func randomID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("secure random source unavailable")
	}
	return hex.EncodeToString(value[:])
}

func validatePublicBaseURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != ""
}
