package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
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
	sepoliaChainID = 11155111
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
	IntentID           string   `json:"intentId"`
	RequestID          string   `json:"requestId"`
	Recipient          string   `json:"recipient"`
	RegistryAddress    string   `json:"registryAddress"`
	ChainID            int      `json:"chainId"`
	MetadataURI        string   `json:"metadataUri"`
	MetadataSHA256     string   `json:"metadataSha256"`
	ContractFunction   string   `json:"contractFunction"`
	ContractArguments  []string `json:"contractArguments"`
	Status             string   `json:"status"`
	TransactionHash    string   `json:"transactionHash,omitempty"`
	CreatedAt          string   `json:"createdAt"`
	payloadHash        string
	uploadID           string
	idempotencyKeyHash string
}

type rwaService struct {
	mu               sync.RWMutex
	config           rwaConfig
	store            objectStore
	uploads          map[string]*uploadSession
	intents          map[string]*mintIntent
	intentByKey      map[string]string
	vaultIntents     map[string]*vaultIntent
	vaultIntentByKey map[string]string
	now              func() time.Time
	db               persistenceDB
	requireDB        bool
	indexerKeyHash   [32]byte
	indexerEnabled   bool
	operatorKeyHash  [32]byte
	operatorEnabled  bool
	requireOperator  bool
}

type uploadIntentRequest struct {
	FileName    string `json:"fileName"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
}

type mintIntentRequest struct {
	UploadID    string `json:"uploadId"`
	Recipient   string `json:"recipient"`
	Name        string `json:"name"`
	Artist      string `json:"artist"`
	Year        int    `json:"year"`
	Medium      string `json:"medium"`
	Location    string `json:"location"`
	Description string `json:"description"`
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
	if operatorToken := strings.TrimSpace(os.Getenv("ARTFI_OPERATOR_BEARER_TOKEN")); operatorToken != "" {
		service.operatorKeyHash = sha256.Sum256([]byte(operatorToken))
		service.operatorEnabled = true
	}
	if indexerKey := strings.TrimSpace(os.Getenv("ARTFI_INDEXER_SHARED_KEY")); indexerKey != "" {
		service.indexerKeyHash = sha256.Sum256([]byte(indexerKey))
		service.indexerEnabled = true
	}
	service.attachPersistence(strings.TrimSpace(os.Getenv("MYSQL_DSN")))
	return service
}

func newRWAService(config rwaConfig, store objectStore) *rwaService {
	return &rwaService{
		config:           config,
		store:            store,
		uploads:          make(map[string]*uploadSession),
		intents:          make(map[string]*mintIntent),
		intentByKey:      make(map[string]string),
		vaultIntents:     make(map[string]*vaultIntent),
		vaultIntentByKey: make(map[string]string),
		now:              func() time.Time { return time.Now().UTC() },
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
		writeProblem(writer, request, http.StatusServiceUnavailable, "Write path unavailable", "Sepolia registry and object storage configuration are required.")
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
	service.mu.RLock()
	session := service.uploads[request.PathValue("uploadID")]
	service.mu.RUnlock()
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
	service.mu.Unlock()
	writer.WriteHeader(http.StatusNoContent)
}

func (service *rwaService) createMintIntent(writer http.ResponseWriter, request *http.Request) {
	if !service.writeEnabled() {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Write path unavailable", "Sepolia registry and object storage configuration are required.")
		return
	}
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) < 16 || len(idempotencyKey) > 128 {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid idempotency key", "Idempotency-Key must contain 16 to 128 characters.")
		return
	}

	var input mintIntentRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid mint intent", err.Error())
		return
	}
	if !addressPattern.MatchString(input.Recipient) || !validMetadataFields(input) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid RWA metadata", "Recipient and required metadata fields failed validation.")
		return
	}

	service.mu.RLock()
	upload := service.uploads[input.UploadID]
	service.mu.RUnlock()
	if upload == nil || !upload.Completed {
		writeProblem(writer, request, http.StatusConflict, "Upload incomplete", "The referenced image must be uploaded and digest-verified first.")
		return
	}

	payload, _ := json.Marshal(input)
	payloadDigest := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(payloadDigest[:])
	keyDigest := sha256.Sum256([]byte(idempotencyKey))
	keyHash := hex.EncodeToString(keyDigest[:])

	service.mu.RLock()
	existingID := service.intentByKey[keyHash]
	existing := service.intents[existingID]
	service.mu.RUnlock()
	if existing != nil {
		if existing.payloadHash != payloadHash {
			writeProblem(writer, request, http.StatusConflict, "Idempotency conflict", "The key was already used with a different payload.")
			return
		}
		writeJSON(writer, http.StatusOK, existing)
		return
	}

	imageURL := service.publicURL(upload.ObjectKey)
	metadata := map[string]any{
		"name":        input.Name,
		"description": input.Description,
		"image":       imageURL,
		"attributes": []map[string]any{
			{"trait_type": "Artist", "value": input.Artist},
			{"trait_type": "Year", "value": input.Year},
			{"trait_type": "Medium", "value": input.Medium},
			{"trait_type": "Location", "value": input.Location},
		},
		"artfi": map[string]any{"schemaVersion": 1, "imageSha256": upload.SHA256, "chainId": sepoliaChainID},
	}
	metadataJSON, _ := json.Marshal(metadata)
	metadataDigest := sha256.Sum256(metadataJSON)
	metadataSHA := hex.EncodeToString(metadataDigest[:])
	metadataKey := fmt.Sprintf("rwa/metadata/%s.json", metadataSHA)
	if err := service.store.Put(request.Context(), metadataKey, metadataJSON, "application/json", metadataSHA); err != nil {
		writeProblem(writer, request, http.StatusBadGateway, "Object storage failure", "The immutable metadata document could not be persisted.")
		return
	}

	requestDigest := sha256.Sum256(append(keyDigest[:], payloadDigest[:]...))
	requestID := "0x" + hex.EncodeToString(requestDigest[:])
	intent := &mintIntent{
		IntentID:           randomID(),
		RequestID:          requestID,
		Recipient:          input.Recipient,
		RegistryAddress:    service.config.registryAddress,
		ChainID:            sepoliaChainID,
		MetadataURI:        service.publicURL(metadataKey),
		MetadataSHA256:     "0x" + metadataSHA,
		ContractFunction:   "createAsset(bytes32,address,string,bytes32)",
		ContractArguments:  []string{requestID, input.Recipient, service.publicURL(metadataKey), "0x" + metadataSHA},
		Status:             "prepared",
		CreatedAt:          service.now().Format(time.RFC3339),
		payloadHash:        payloadHash,
		uploadID:           upload.ID,
		idempotencyKeyHash: keyHash,
	}
	if err := service.persistMintIntent(request.Context(), intent); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Persistence unavailable", "The mint intent could not be recorded durably.")
		return
	}
	service.mu.Lock()
	service.intents[intent.IntentID] = intent
	service.intentByKey[keyHash] = intent.IntentID
	service.mu.Unlock()
	writeJSON(writer, http.StatusCreated, intent)
}

func (service *rwaService) getMintIntent(writer http.ResponseWriter, request *http.Request) {
	service.mu.RLock()
	intent := service.intents[request.PathValue("intentID")]
	service.mu.RUnlock()
	if intent == nil {
		writeProblem(writer, request, http.StatusNotFound, "Mint intent not found", "No mint intent matches the requested identifier.")
		return
	}
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) recordSubmission(writer http.ResponseWriter, request *http.Request) {
	var input submissionRequest
	if err := decodeJSON(request, &input); err != nil || !txHashPattern.MatchString(input.TransactionHash) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid transaction hash", "Use a 32-byte 0x-prefixed transaction hash.")
		return
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	intent := service.intents[request.PathValue("intentID")]
	if intent == nil {
		writeProblem(writer, request, http.StatusNotFound, "Mint intent not found", "No mint intent matches the requested identifier.")
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
	intent.TransactionHash = input.TransactionHash
	intent.Status = "submitted"
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
