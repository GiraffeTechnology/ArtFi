package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealth(t *testing.T) {
	recorder := request(t, http.MethodGet, "/healthz")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}
	var response statusResponse
	decode(t, recorder, &response)
	if response.Service != "artfi-api" || response.Status != "ok" {
		t.Fatalf("unexpected response: %+v", response)
	}
}

func TestConfigIsSepoliaReadOnly(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/config")
	var response configResponse
	decode(t, recorder, &response)
	if response.ChainID != 84532 || !response.ReadOnly || response.Network != "base-sepolia" {
		t.Fatalf("unsafe config: %+v", response)
	}
}

func TestGovernanceConfigFailsClosedWithoutAddresses(t *testing.T) {
	t.Setenv("ARTFI_DAO_ACTIONS_ADDRESS", "")
	t.Setenv("ARTFI_GOVERNOR_ADDRESS", "")
	t.Setenv("ARTFI_GOVERNANCE_TOKEN_ADDRESS", "")
	t.Setenv("ARTFI_RWA_VAULT_ADDRESS", "")
	recorder := request(t, http.MethodGet, "/v1/governance/config")
	var response governanceConfigResponse
	decode(t, recorder, &response)
	if response.Enabled || response.MembershipAuthority != "onchain-rwa-token-snapshot" || response.ProposalThresholdPPM != 100_000 {
		t.Fatalf("unsafe governance config: %+v", response)
	}
	if response.ApprovalPPM["marketMigration"] != 500_000 || response.ApprovalPPM["physicalAction"] != 666_667 || response.ApprovalPPM["forcedBuyout"] != 800_000 {
		t.Fatalf("unexpected governance thresholds: %+v", response.ApprovalPPM)
	}
}

func TestGovernanceConfigEnablesOnlyWithCompleteValidAddresses(t *testing.T) {
	t.Setenv("ARTFI_DAO_ACTIONS_ADDRESS", "0x1111111111111111111111111111111111111111")
	t.Setenv("ARTFI_GOVERNOR_ADDRESS", "0x2222222222222222222222222222222222222222")
	t.Setenv("ARTFI_GOVERNANCE_TOKEN_ADDRESS", "0x3333333333333333333333333333333333333333")
	t.Setenv("ARTFI_RWA_VAULT_ADDRESS", "0x4444444444444444444444444444444444444444")
	recorder := request(t, http.MethodGet, "/v1/governance/config")
	var response governanceConfigResponse
	decode(t, recorder, &response)
	if !response.Enabled || response.ChainID != baseSepoliaChainID {
		t.Fatalf("complete governance config was not enabled: %+v", response)
	}
}

func TestGovernanceProposalIndexFailsClosedWithoutDatabase(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	recorder := httptest.NewRecorder()
	newHandler(service).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/governance/proposals", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected unavailable proposal index, got %d", recorder.Code)
	}
}

func TestAssetLookup(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/blue-hour-archive")
	var response asset
	decode(t, recorder, &response)
	if response.Slug != "blue-hour-archive" || response.ValuationUSD <= 0 {
		t.Fatalf("unexpected asset: %+v", response)
	}
}

func TestMissingAssetUsesProblemJSON(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets/missing")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/problem+json; charset=utf-8" {
		t.Fatalf("unexpected content type: %s", got)
	}
	var response problem
	decode(t, recorder, &response)
	if response.RequestID == "" {
		t.Fatal("expected request id")
	}
}

func TestPortfolioRejectsInvalidAddress(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/portfolio/not-an-address")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", recorder.Code)
	}
}

func TestAssetSearchFilterAndPagination(t *testing.T) {
	recorder := request(t, http.MethodGet, "/v1/assets?q=mina&status=Fractionalized&page=1&pageSize=1")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var response struct {
		Data     []asset `json:"data"`
		Total    int     `json:"total"`
		Page     int     `json:"page"`
		PageSize int     `json:"pageSize"`
	}
	decode(t, recorder, &response)
	if response.Total != 1 || len(response.Data) != 1 || response.Data[0].Slug != "blue-hour-archive" || response.Page != 1 || response.PageSize != 1 {
		t.Fatalf("unexpected filtered page: %+v", response)
	}
}

func TestIndexerFailsClosedWithoutDurableConfiguration(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	recorder := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/indexer/events", map[string]any{}, map[string]string{"X-Indexer-Key": "test"})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected disabled indexer, got %d", recorder.Code)
	}
}

func TestOperatorWritesFailClosedAndUseConstantCredentialBoundary(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.requireOperator = true
	service.operatorEnabled = true
	service.operatorKeyHash = sha256.Sum256([]byte("stage6-operator-test-token"))
	handler := newHandler(service)
	unauthorized := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", map[string]any{}, nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected operator authentication failure, got %d", unauthorized.Code)
	}
	authorized := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", map[string]any{}, map[string]string{
		"Authorization": "Bearer stage6-operator-test-token",
	})
	if authorized.Code == http.StatusUnauthorized {
		t.Fatal("valid operator credential was rejected")
	}
}

func TestOpenSeaDiscoveryVerifiesSupportedChainAndExactNFT(t *testing.T) {
	contract := "0x1111111111111111111111111111111111111111"
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-API-Key") != "discovery-test-key" {
			t.Fatal("OpenSea API key was not sent server-side")
		}
		switch request.URL.Path {
		case "/api/v2/chains":
			writeJSON(writer, http.StatusOK, map[string]any{
				"chains": []map[string]string{{"chain": "base-sepolia"}},
			})
		case "/api/v2/chain/base-sepolia/contract/" + contract + "/nfts/42":
			writeJSON(writer, http.StatusOK, map[string]any{
				"nft": map[string]string{
					"identifier":     "42",
					"collection":     "artcch-test",
					"token_standard": "erc721",
				},
			})
		default:
			t.Fatalf("unexpected OpenSea discovery path: %s", request.URL.Path)
		}
	}))
	defer upstream.Close()

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.openseaAPIKey = "discovery-test-key"
	service.openseaAPIBaseURL = upstream.URL
	response := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/rwa/discovery-checks", map[string]string{
		"source": "opensea", "chain": "base-sepolia", "contractAddress": contract, "tokenId": "42",
	}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("discovery check: status=%d body=%s", response.Code, response.Body.String())
	}
	var result openSeaDiscoveryResponse
	decode(t, response, &result)
	if !result.Discovered || result.Result != "discovered" || result.TokenStandard != "erc721" ||
		result.EvidenceSHA256 == "" || !strings.HasPrefix(result.MarketplaceURL, "https://opensea.io/") {
		t.Fatalf("unsafe discovery result: %+v", result)
	}
}

func TestOpenSeaDiscoveryRecordsUnsupportedChainWithoutNFTClaim(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v2/chains" {
			t.Fatalf("unsupported chain must not trigger NFT lookup: %s", request.URL.Path)
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"chains": []map[string]string{{"chain": "ethereum"}},
		})
	}))
	defer upstream.Close()

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.openseaAPIKey = "discovery-test-key"
	service.openseaAPIBaseURL = upstream.URL
	response := jsonRequest(t, newHandler(service), http.MethodPost, "/v1/rwa/discovery-checks", map[string]string{
		"source":          "opensea",
		"chain":           "base-sepolia",
		"contractAddress": "0x1111111111111111111111111111111111111111",
		"tokenId":         "42",
	}, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("unsupported chain check: status=%d body=%s", response.Code, response.Body.String())
	}
	var result openSeaDiscoveryResponse
	decode(t, response, &result)
	if result.Discovered || result.Result != "unsupported-chain" || result.MarketplaceURL != "" {
		t.Fatalf("unsupported chain was misrepresented: %+v", result)
	}
}

func TestPreflight(t *testing.T) {
	recorder := request(t, http.MethodOptions, "/v1/assets")
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("unexpected origin: %s", got)
	}
}

func TestRWAUploadMintAndSubmissionLifecycle(t *testing.T) {
	store := newMemoryObjectStore()
	service := newRWAService(rwaConfig{
		registryAddress: "0x1111111111111111111111111111111111111111",
		publicBaseURL:   "https://assets.artfi.test",
	}, store)
	handler := newHandler(service)
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(image)
	digestHex := hex.EncodeToString(digest[:])
	uploadBody := map[string]any{"fileName": "proof.png", "contentType": "image/png", "sha256": digestHex, "size": len(image)}
	uploadRecorder := jsonRequest(t, handler, http.MethodPost, "/v1/uploads/intents", uploadBody, nil)
	if uploadRecorder.Code != http.StatusCreated {
		t.Fatalf("create upload: status=%d body=%s", uploadRecorder.Code, uploadRecorder.Body.String())
	}
	var upload struct {
		UploadID  string `json:"uploadId"`
		UploadURL string `json:"uploadUrl"`
	}
	decode(t, uploadRecorder, &upload)

	putRequest := httptest.NewRequest(http.MethodPut, upload.UploadURL, bytes.NewReader(image))
	putRequest.Header.Set("Content-Type", "image/png")
	putRequest.Header.Set("Content-SHA256", digestHex)
	putRecorder := httptest.NewRecorder()
	handler.ServeHTTP(putRecorder, putRequest)
	if putRecorder.Code != http.StatusNoContent {
		t.Fatalf("upload object: status=%d body=%s", putRecorder.Code, putRecorder.Body.String())
	}

	mintBody := map[string]any{
		"uploadId":    upload.UploadID,
		"recipient":   "0x2222222222222222222222222222222222222222",
		"name":        "Proof of Light",
		"artist":      "Mina Okafor",
		"year":        2024,
		"medium":      "Pigment on linen",
		"location":    "Lagos",
		"description": "A rights-cleared testnet record used to validate the Stage 2 mint flow.",
	}
	headers := map[string]string{"Idempotency-Key": "stage2-test-idempotency-key"}
	mintRecorder := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if mintRecorder.Code != http.StatusCreated {
		t.Fatalf("create mint: status=%d body=%s", mintRecorder.Code, mintRecorder.Body.String())
	}
	var intent mintIntent
	decode(t, mintRecorder, &intent)
	if intent.ChainID != baseSepoliaChainID || len(intent.ContractArguments) != 4 || intent.Status != "prepared" {
		t.Fatalf("unsafe intent: %+v", intent)
	}

	replay := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("idempotent replay: status=%d body=%s", replay.Code, replay.Body.String())
	}
	var replayed mintIntent
	decode(t, replay, &replayed)
	if replayed.IntentID != intent.IntentID {
		t.Fatal("idempotent replay created a second intent")
	}

	mintBody["name"] = "Conflicting title"
	conflict := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents", mintBody, headers)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected idempotency conflict, got %d", conflict.Code)
	}

	txHash := "0x" + strings.Repeat("a", 64)
	submission := jsonRequest(t, handler, http.MethodPost, "/v1/rwa/intents/"+intent.IntentID+"/submission", map[string]string{"transactionHash": txHash}, nil)
	if submission.Code != http.StatusOK {
		t.Fatalf("record submission: status=%d body=%s", submission.Code, submission.Body.String())
	}
	var submitted mintIntent
	decode(t, submission, &submitted)
	if submitted.Status != "submitted" || submitted.TransactionHash != txHash {
		t.Fatalf("unexpected submission: %+v", submitted)
	}
}

func TestUploadRejectsDigestMismatch(t *testing.T) {
	service := newRWAService(rwaConfig{
		registryAddress: "0x1111111111111111111111111111111111111111",
		publicBaseURL:   "https://assets.artfi.test",
	}, newMemoryObjectStore())
	handler := newHandler(service)
	body := []byte("not-an-image")
	digest := sha256.Sum256(body)
	upload := jsonRequest(t, handler, http.MethodPost, "/v1/uploads/intents", map[string]any{
		"fileName": "proof.png", "contentType": "image/png", "sha256": hex.EncodeToString(digest[:]), "size": len(body),
	}, nil)
	var response struct {
		UploadURL string `json:"uploadUrl"`
	}
	decode(t, upload, &response)

	put := httptest.NewRequest(http.MethodPut, response.UploadURL, bytes.NewReader([]byte("tampered-data")))
	put.Header.Set("Content-Type", "image/png")
	put.Header.Set("Content-SHA256", hex.EncodeToString(digest[:]))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, put)
	if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected rejected upload, got %d", recorder.Code)
	}
}

func TestVaultIntentIsIdempotentAndSubmissionBound(t *testing.T) {
	service := newRWAService(rwaConfig{
		vaultFactoryAddress: "0x3333333333333333333333333333333333333333",
	}, newMemoryObjectStore())
	handler := newHandler(service)
	body := map[string]any{
		"collectionAddress":     "0x1111111111111111111111111111111111111111",
		"tokenId":               "340282366920938463463374607431768211455",
		"vaultName":             "Material Memory Vault",
		"adminAddress":          "0x2222222222222222222222222222222222222222",
		"pauserAddress":         "0x4444444444444444444444444444444444444444",
		"fractionalizerAddress": "0x5555555555555555555555555555555555555555",
	}
	headers := map[string]string{"Idempotency-Key": "stage3-vault-idempotency"}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if created.Code != http.StatusCreated {
		t.Fatalf("create vault intent: status=%d body=%s", created.Code, created.Body.String())
	}
	var intent vaultIntent
	decode(t, created, &intent)
	if intent.ChainID != baseSepoliaChainID || len(intent.ContractArguments) != 7 || intent.Status != "prepared" {
		t.Fatalf("unsafe vault intent: %+v", intent)
	}

	replay := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("vault replay: status=%d body=%s", replay.Code, replay.Body.String())
	}

	body["vaultName"] = "Conflicting Vault"
	conflict := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents", body, headers)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected vault conflict, got %d", conflict.Code)
	}

	txHash := "0x" + strings.Repeat("b", 64)
	submission := jsonRequest(t, handler, http.MethodPost, "/v1/vault/intents/"+intent.IntentID+"/submission", map[string]string{"transactionHash": txHash}, nil)
	if submission.Code != http.StatusOK {
		t.Fatalf("vault submission: status=%d body=%s", submission.Code, submission.Body.String())
	}
	var submitted vaultIntent
	decode(t, submission, &submitted)
	if submitted.Status != "submitted" || submitted.TransactionHash != txHash {
		t.Fatalf("unexpected vault submission: %+v", submitted)
	}
}

func request(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, req)
	return recorder
}

func jsonRequest(t *testing.T, handler http.Handler, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder, value interface{}) {
	t.Helper()
	if err := json.NewDecoder(recorder.Body).Decode(value); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}
