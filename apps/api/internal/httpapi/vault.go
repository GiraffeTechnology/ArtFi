package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var uint256Pattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)

type vaultIntentRequest struct {
	CollectionAddress     string `json:"collectionAddress"`
	TokenID               string `json:"tokenId"`
	VaultName             string `json:"vaultName"`
	AdminAddress          string `json:"adminAddress"`
	PauserAddress         string `json:"pauserAddress"`
	FractionalizerAddress string `json:"fractionalizerAddress"`
}

type vaultIntent struct {
	IntentID              string   `json:"intentId"`
	RequestID             string   `json:"requestId"`
	FactoryAddress        string   `json:"factoryAddress"`
	CollectionAddress     string   `json:"collectionAddress"`
	TokenID               string   `json:"tokenId"`
	VaultName             string   `json:"vaultName"`
	AdminAddress          string   `json:"adminAddress"`
	PauserAddress         string   `json:"pauserAddress"`
	FractionalizerAddress string   `json:"fractionalizerAddress"`
	ChainID               int      `json:"chainId"`
	ContractFunction      string   `json:"contractFunction"`
	ContractArguments     []string `json:"contractArguments"`
	Status                string   `json:"status"`
	TransactionHash       string   `json:"transactionHash,omitempty"`
	CreatedAt             string   `json:"createdAt"`
	payloadHash           string
	idempotencyKeyHash    string
}

func (service *rwaService) vaultWriteEnabled() bool {
	return addressPattern.MatchString(service.config.vaultFactoryAddress) &&
		(!service.requireDB || service.db != nil)
}

func (service *rwaService) createVaultIntent(writer http.ResponseWriter, request *http.Request) {
	service.mintMu.Lock()
	defer service.mintMu.Unlock()
	if !service.vaultWriteEnabled() {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Vault write path unavailable", "A reviewed Hoodi VaultFactory and durable persistence are required.")
		return
	}
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) < 16 || len(idempotencyKey) > 128 {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid idempotency key", "Idempotency-Key must contain 16 to 128 characters.")
		return
	}
	var input vaultIntentRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid vault intent", err.Error())
		return
	}
	if !validVaultIntent(input) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid vault configuration", "Addresses, token ID, and vault name failed validation.")
		return
	}

	if err := service.requireGroundedUnderlying(request.Context(), input.CollectionAddress, input.TokenID); err != nil {
		service.writeRWAError(writer, request, err)
		return
	}

	payload, _ := json.Marshal(input)
	payloadDigest := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(payloadDigest[:])
	keyDigest := sha256.Sum256([]byte(idempotencyKey))
	keyHash := hex.EncodeToString(keyDigest[:])

	service.mu.RLock()
	existing := service.vaultIntents[service.vaultIntentByKey[keyHash]]
	service.mu.RUnlock()
	if existing != nil && service.db == nil {
		if existing.payloadHash != payloadHash {
			writeProblem(writer, request, http.StatusConflict, "Idempotency conflict", "The key was already used with a different vault configuration.")
			return
		}
		writeJSON(writer, http.StatusOK, existing)
		return
	}

	requestDigest := sha256.Sum256(append(keyDigest[:], payloadDigest[:]...))
	requestID := "0x" + hex.EncodeToString(requestDigest[:])
	intent := &vaultIntent{
		IntentID:              randomID(),
		RequestID:             requestID,
		FactoryAddress:        service.config.vaultFactoryAddress,
		CollectionAddress:     input.CollectionAddress,
		TokenID:               input.TokenID,
		VaultName:             input.VaultName,
		AdminAddress:          input.AdminAddress,
		PauserAddress:         input.PauserAddress,
		FractionalizerAddress: input.FractionalizerAddress,
		ChainID:               hoodiChainID,
		ContractFunction:      "createVault(bytes32,string,address,uint256,address,address,address)",
		ContractArguments: []string{
			requestID, input.VaultName, input.CollectionAddress, input.TokenID,
			input.AdminAddress, input.PauserAddress, input.FractionalizerAddress,
		},
		Status:             "prepared",
		CreatedAt:          service.now().Format(time.RFC3339),
		payloadHash:        payloadHash,
		idempotencyKeyHash: keyHash,
	}
	stored, created, err := service.persistOrReadVault(request.Context(), intent)
	if err != nil {
		service.writeRWAError(writer, request, err)
		return
	}
	intent = stored
	service.mu.Lock()
	service.vaultIntents[intent.IntentID] = intent
	service.vaultIntentByKey[keyHash] = intent.IntentID
	service.mu.Unlock()
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(writer, status, intent)
}

func (service *rwaService) getVaultIntent(writer http.ResponseWriter, request *http.Request) {
	intent, err := service.readVaultIntent(request.Context(), request.PathValue("intentID"))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		service.writeRWAError(writer, request, err)
		return
	}
	if intent == nil {
		writeProblem(writer, request, http.StatusNotFound, "Vault intent not found", "No vault intent matches the requested identifier.")
		return
	}
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) recordVaultSubmission(writer http.ResponseWriter, request *http.Request) {
	var input submissionRequest
	if err := decodeJSON(request, &input); err != nil || !txHashPattern.MatchString(input.TransactionHash) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid transaction hash", "Use a 32-byte 0x-prefixed transaction hash.")
		return
	}
	intent, err := service.readVaultIntent(request.Context(), request.PathValue("intentID"))
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		service.writeRWAError(writer, request, err)
		return
	}
	if intent == nil {
		writeProblem(writer, request, http.StatusNotFound, "Vault intent not found", "No vault intent matches the requested identifier.")
		return
	}
	if intent.TransactionHash != "" && !strings.EqualFold(intent.TransactionHash, input.TransactionHash) {
		writeProblem(writer, request, http.StatusConflict, "Submission conflict", "A different transaction is already attached to this vault intent.")
		return
	}
	if err := service.persistVaultSubmission(request.Context(), intent.IntentID, input.TransactionHash); err != nil {
		if errors.Is(err, errVaultSubmissionConflict) {
			writeProblem(writer, request, 409, "Submission conflict", "A different transaction is already attached to this Vault intent.")
			return
		}
		writeProblem(writer, request, http.StatusServiceUnavailable, "Persistence unavailable", "The vault transaction could not be recorded durably.")
		return
	}
	intent.TransactionHash = input.TransactionHash
	intent.Status = "submitted"
	service.mu.Lock()
	service.vaultIntents[intent.IntentID] = intent
	service.mu.Unlock()
	writeJSON(writer, http.StatusOK, intent)
}

func validVaultIntent(input vaultIntentRequest) bool {
	return addressPattern.MatchString(input.CollectionAddress) &&
		addressPattern.MatchString(input.AdminAddress) &&
		addressPattern.MatchString(input.PauserAddress) &&
		addressPattern.MatchString(input.FractionalizerAddress) &&
		uint256Pattern.MatchString(input.TokenID) &&
		len(strings.TrimSpace(input.VaultName)) >= 2 && len(input.VaultName) <= 80
}
