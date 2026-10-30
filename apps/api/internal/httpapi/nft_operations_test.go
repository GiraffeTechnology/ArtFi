package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNFTOperationTransitionsPreserveUncertainty(t *testing.T) {
	for _, pair := range [][2]string{{"awaiting-wallet", "pending"}, {"awaiting-wallet", "submitted"}, {"submitted", "pending"}, {"pending", "confirmed"}, {"confirmed", "pending"}, {"failed", "pending"}, {"pending", "failed"}, {"submitted", "accepted"}} {
		if !validNFTTransition(pair[0], pair[1]) {
			t.Fatalf("valid transition rejected: %v", pair)
		}
	}
	for _, pair := range [][2]string{{"awaiting-wallet", "confirmed"}, {"submitted", "confirmed"}, {"confirmed", "awaiting-wallet"}, {"failed", "awaiting-wallet"}, {"cancelled", "confirmed"}} {
		if validNFTTransition(pair[0], pair[1]) {
			t.Fatalf("unsafe transition accepted: %v", pair)
		}
	}
}
func TestNFTPlanRejectsPrivateOrSignedPayloads(t *testing.T) {
	for _, field := range []string{"signature", "privateKey", "seedPhrase", "rawTransaction", "accessToken", "apiKey"} {
		if nftPlanSafe(map[string]any{"nested": []any{map[string]any{field: "synthetic"}}}) {
			t.Fatalf("accepted %s", field)
		}
	}
	if !nftPlanSafe(map[string]any{"kind": "signature", "typedData": map[string]any{"message": map[string]any{"offerer": "test"}}}) {
		t.Fatal("unsigned typed data was rejected")
	}
	if nftRequestDigest([]byte(`{"a":1,"b":2}`)) != nftRequestDigest([]byte(`{ "b": 2, "a": 1 }`)) {
		t.Fatal("MySQL JSON normalization changed operation identity")
	}
}
func nftIntegrationRequest(t *testing.T, service *userAuthService, action string, operation nftOperation, token string) *httptest.ResponseRecorder {
	t.Helper()
	payload, _ := json.Marshal(nftOperationInput{Action: action, AccessToken: token, Operation: operation})
	request := httptest.NewRequest(http.MethodPost, "/v1/nft/operations", bytes.NewReader(payload))
	request.Header.Set("Authorization", "Bearer "+string(service.bridgeToken))
	response := httptest.NewRecorder()
	service.nftOperations(response, request)
	return response
}
func TestMySQLNFTOperationIdempotencyOwnershipAndCAS(t *testing.T) {
	db, service, _, address := walletAuthIntegrationFixture(t)
	tokens := walletAuthIntegrationLogin(t, service, address)
	id := "nft-" + strings.TrimPrefix(address, "0x")
	t.Cleanup(func() { _, _ = db.Exec("DELETE FROM nft_operations WHERE operation_id=?", id) })
	plan := json.RawMessage(fmt.Sprintf(`{"operationId":%q,"sessionId":%q,"chainId":560048,"request":{"account":%q},"kind":"signature","typedData":{"message":{"counter":"0"}}}`, id, tokens.Session.ID, address))
	operation := nftOperation{ID: id, Wallet: address, ChainID: hoodiChainID, RequestHash: strings.Repeat("a", 64), Revision: 1, Status: "awaiting-wallet", Plan: plan}
	created := nftIntegrationRequest(t, service, "create", operation, tokens.AccessToken)
	if created.Code != 200 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	retry := nftIntegrationRequest(t, service, "create", operation, tokens.AccessToken)
	if retry.Code != 200 {
		t.Fatalf("retry: %d %s", retry.Code, retry.Body.String())
	}
	changed := operation
	changed.RequestHash = strings.Repeat("b", 64)
	if response := nftIntegrationRequest(t, service, "create", changed, tokens.AccessToken); response.Code != 409 {
		t.Fatalf("idempotency rebinding accepted: %d", response.Code)
	}
	var stored nftOperation
	if err := json.Unmarshal(retry.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}

	stored.WalletStarted = true
	started := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken)
	if started.Code != 200 {
		t.Fatalf("start wallet: %d %s", started.Code, started.Body.String())
	}
	if duplicate := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken); duplicate.Code != 409 {
		t.Fatalf("stale wallet start accepted: %d", duplicate.Code)
	}
	if err := json.Unmarshal(started.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	reset := stored
	reset.WalletStarted = false
	if response := nftIntegrationRequest(t, service, "update", reset, tokens.AccessToken); response.Code != 409 {
		t.Fatalf("wallet attempt reset: %d", response.Code)
	}
	stored.Status = "submitted"
	stored.OrderHash = "0x" + strings.Repeat("7", 64)
	submitted := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken)
	if submitted.Code != 200 {
		t.Fatalf("submit: %d %s", submitted.Code, submitted.Body.String())
	}
	if duplicate := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken); duplicate.Code != 409 {
		t.Fatalf("stale update accepted: %d", duplicate.Code)
	}
	if err := json.Unmarshal(submitted.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	stored.Status = "pending"
	pending := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken)
	if pending.Code != 200 {
		t.Fatalf("pending: %d %s", pending.Code, pending.Body.String())
	}
	if err := json.Unmarshal(pending.Body.Bytes(), &stored); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"confirmed", "pending", "failed", "pending", "confirmed"} {
		stored.Status = status
		response := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken)
		if response.Code != 200 {
			t.Fatalf("receipt reorganization to %s: %d %s", status, response.Code, response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), &stored); err != nil {
			t.Fatal(err)
		}
	}
	original := stored
	stored.OrderHash = "0x" + strings.Repeat("8", 64)
	if response := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken); response.Code != 409 {
		t.Fatalf("order hash replaced: %d", response.Code)
	}
	stored = original
	var alteredPlan map[string]any
	if err := json.Unmarshal(stored.Plan, &alteredPlan); err != nil {
		t.Fatal(err)
	}
	alteredPlan["typedData"].(map[string]any)["message"].(map[string]any)["counter"] = "1"
	stored.Plan, _ = json.Marshal(alteredPlan)
	if response := nftIntegrationRequest(t, service, "update", stored, tokens.AccessToken); response.Code != 409 {
		t.Fatalf("review terms replaced: %d %s", response.Code, response.Body.String())
	}
	other := walletAuthIntegrationLogin(t, service, userAuthTestAddress)
	if response := nftIntegrationRequest(t, service, "get", nftOperation{ID: id}, other.AccessToken); response.Code != 403 {
		t.Fatalf("other owner read operation: %d", response.Code)
	}
	if _, err := db.Exec("UPDATE wallet_user_sessions SET revoked_at=NOW(6) WHERE session_id=?", tokens.Session.ID); err != nil {
		t.Fatal(err)
	}
	if response := nftIntegrationRequest(t, service, "get", nftOperation{ID: id}, tokens.AccessToken); response.Code != 401 {
		t.Fatalf("revoked session read operation: %d", response.Code)
	}
}
func TestUserAuthenticationChainOptIn(t *testing.T) {
	t.Setenv("ARTFI_USER_AUTH_CHAIN_IDS", "")
	if !userAuthChainEnabled(hoodiChainID) || userAuthChainEnabled(1) || userAuthChainEnabled(8453) {
		t.Fatal("default session chain broadened")
	}
	t.Setenv("ARTFI_USER_AUTH_CHAIN_IDS", "560048, 1,8453")
	for _, id := range []int{hoodiChainID, 1, 8453} {
		if !userAuthChainEnabled(id) {
			t.Fatalf("configured session chain %d rejected", id)
		}
	}
	t.Setenv("ARTFI_USER_AUTH_CHAIN_IDS", "1,31337")
	if userAuthChainEnabled(31337) || userAuthChainEnabled(hoodiChainID) {
		t.Fatal("unsupported or disabled session chain accepted")
	}
}

func TestMySQLNFTHistoryIsOwnerBoundPaginatedAndUnsigned(t *testing.T) {
	db, service, _, address := walletAuthIntegrationFixture(t)
	tokens := walletAuthIntegrationLogin(t, service, address)
	t.Cleanup(func() { _, _ = db.Exec("DELETE FROM nft_operations WHERE wallet_address=?", address) })
	for i := 0; i < 27; i++ {
		id := fmt.Sprintf("history-%s-%02d", strings.TrimPrefix(address, "0x"), i)
		plan := json.RawMessage(fmt.Sprintf(`{"operationId":%q,"sessionId":%q,"chainId":560048,"request":{"account":%q,"action":"list","collection":"isolated-digital","tokenId":%q},"kind":"signature","typedData":{"message":{"counter":"0"}}}`, id, tokens.Session.ID, address, fmt.Sprint(i)))
		operation := nftOperation{ID: id, Wallet: address, ChainID: hoodiChainID, RequestHash: strings.Repeat("a", 64), Status: "awaiting-wallet", Plan: plan}
		if result := nftIntegrationRequest(t, service, "create", operation, tokens.AccessToken); result.Code != 200 {
			t.Fatalf("fixture creation status %d", result.Code)
		}
	}
	read := func(page int, token string, bridge bool) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(nftHistoryInput{AccessToken: token, Page: page})
		r := httptest.NewRequest("POST", "/v1/nft/operations/history", bytes.NewReader(payload))
		if bridge {
			r.Header.Set("Authorization", "Bearer "+string(service.bridgeToken))
		}
		w := httptest.NewRecorder()
		service.nftOperationHistory(w, r)
		return w
	}
	first := read(1, tokens.AccessToken, true)
	if first.Code != 200 || first.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("history read status %d", first.Code)
	}
	var result struct {
		Data    []nftHistoryItem `json:"data"`
		HasMore bool             `json:"hasMore"`
		Wallet  string           `json:"wallet"`
	}
	if json.Unmarshal(first.Body.Bytes(), &result) != nil || len(result.Data) != 25 || !result.HasMore || result.Wallet != address {
		t.Fatal("owner history page mismatch")
	}
	if strings.Contains(first.Body.String(), "typedData") || strings.Contains(first.Body.String(), tokens.AccessToken) || strings.Contains(first.Body.String(), "requestHash") {
		t.Fatal("history exposed an unnecessary private payload")
	}
	second := read(2, tokens.AccessToken, true)
	if json.Unmarshal(second.Body.Bytes(), &result) != nil || len(result.Data) != 2 || result.HasMore {
		t.Fatal("history pagination mismatch")
	}
	if read(0, tokens.AccessToken, true).Code != 400 || read(1, tokens.AccessToken, false).Code != 401 {
		t.Fatal("history scope validation failed")
	}
	other := walletAuthIntegrationLogin(t, service, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	empty := read(1, other.AccessToken, true)
	if json.Unmarshal(empty.Body.Bytes(), &result) != nil || len(result.Data) != 0 {
		t.Fatal("another wallet received the owner's history")
	}
	if _, err := db.Exec("UPDATE wallet_user_sessions SET revoked_at=NOW(6) WHERE session_id=?", tokens.Session.ID); err != nil {
		t.Fatal(err)
	}
	if read(1, tokens.AccessToken, true).Code != 401 {
		t.Fatal("revoked session read private operation history")
	}
}
