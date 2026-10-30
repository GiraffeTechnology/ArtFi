package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func syntheticNFTTaskPrincipal() NFTTaskPrincipal {
	return NFTTaskPrincipal{Kind: "task", TaskID: "test-only-task", TaskDigest: "0x" + strings.Repeat("1", 64), ExecutorDigest: "0x" + strings.Repeat("2", 64), GrantReference: "grant:test-only", GrantPolicyVersion: "1", OperationID: "test-only-wallet-operation"}
}
func syntheticNFTTaskOperation() nftOperation {
	plan, _ := json.Marshal(map[string]any{"id": "test-only-plan", "operationId": "native_test_only_operation", "chainId": 1, "taskPrincipal": syntheticNFTTaskPrincipal(), "kind": "signature", "request": map[string]any{"account": userAuthTestAddress, "priceWei": "100"}, "typedData": map[string]any{"message": map[string]any{"counter": "0"}}})
	return nftOperation{ID: "native_test_only_operation", Wallet: userAuthTestAddress, ChainID: 1, RequestHash: strings.Repeat("a", 64), Status: "awaiting-wallet", Plan: plan}
}
func assertNFTStatus(t *testing.T, err error, want int) {
	t.Helper()
	w := httptest.NewRecorder()
	writeNFTStoreError(w, httptest.NewRequest("POST", "/", nil), err)
	if w.Code != want {
		t.Fatalf("got status %d want %d (%v)", w.Code, want, err)
	}
}
func TestNFTSharedStoreTaskStateMachineAndSessionSeparation(t *testing.T) {
	now := time.Now()
	task := syntheticNFTTaskPrincipal()
	principal := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, task: &task}
	original := syntheticNFTTaskOperation()
	stored, write, err := decideNFTMutation(principal, "create", original, nil, now)
	if err != nil || !write || stored.Revision != 1 {
		t.Fatalf("create: %+v %v", stored, err)
	}
	duplicate, write, err := decideNFTMutation(principal, "create", original, &stored, now)
	if err != nil || write || duplicate.Revision != 1 {
		t.Fatalf("idempotent create: %v", err)
	}
	started := stored
	started.WalletStarted = true
	started, write, err = decideNFTMutation(principal, "update", started, &stored, now)
	if err != nil || !write || started.Revision != 2 {
		t.Fatalf("claim CAS: %v", err)
	}
	_, _, err = decideNFTMutation(principal, "update", stored, &started, now)
	assertNFTStatus(t, err, 409)
	reset := started
	reset.WalletStarted = false
	_, _, err = decideNFTMutation(principal, "update", reset, &started, now)
	assertNFTStatus(t, err, 409)
	changed := started
	changed.Plan = bytes.ReplaceAll(changed.Plan, []byte(`"100"`), []byte(`"101"`))
	_, _, err = decideNFTMutation(principal, "update", changed, &started, now)
	assertNFTStatus(t, err, 409)
	_, _, err = decideNFTMutation(principal, "create", changed, &started, now)
	assertNFTStatus(t, err, 409)
	session := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, sessionID: "session-test-only"}
	_, _, err = decideNFTMutation(session, "get", nftOperation{ID: stored.ID}, &stored, now)
	assertNFTStatus(t, err, 403)
	sessionRow := original
	sessionRow.Plan = []byte(`{"operationId":"native_test_only_operation","chainId":1,"sessionId":"session-test-only"}`)
	_, _, err = decideNFTMutation(principal, "get", nftOperation{ID: stored.ID}, &sessionRow, now)
	assertNFTStatus(t, err, 403)
	other := principal
	otherTask := task
	otherTask.TaskID = "foreign-task"
	other.task = &otherTask
	_, _, err = decideNFTMutation(other, "get", nftOperation{ID: stored.ID}, &stored, now)
	assertNFTStatus(t, err, 403)
	other = principal
	other.wallet = "0x" + strings.Repeat("3", 40)
	_, _, err = decideNFTMutation(other, "get", nftOperation{ID: stored.ID}, &stored, now)
	assertNFTStatus(t, err, 403)
}
func TestNFTSharedStoreTaskRejectsSignedPlansAndMixedPrincipals(t *testing.T) {
	task := syntheticNFTTaskPrincipal()
	principal := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, task: &task}
	for _, key := range []string{"signature", "signatures", "typedDataSignature", "private_key", "exactSignature", "privateKey", "rawTransaction", "capability", "seedPhrase", "sessionId"} {
		operation := syntheticNFTTaskOperation()
		var plan map[string]any
		_ = json.Unmarshal(operation.Plan, &plan)
		if key == "sessionId" {
			plan[key] = "fake"
		} else {
			plan["nested"] = map[string]any{key: "TEST_ONLY"}
		}
		operation.Plan, _ = json.Marshal(plan)
		_, _, err := decideNFTMutation(principal, "create", operation, nil, time.Now())
		assertNFTStatus(t, err, 422)
	}
}
func TestNFTTaskStoreRequiresNativePlanIDAndAuthenticatedAccount(t *testing.T) {
	task := syntheticNFTTaskPrincipal()
	principal := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, task: &task}
	for _, field := range []string{"account", "id"} {
		operation := syntheticNFTTaskOperation()
		var plan map[string]any
		_ = json.Unmarshal(operation.Plan, &plan)
		if field == "account" {
			plan["request"].(map[string]any)["account"] = "0x" + strings.Repeat("9", 40)
		} else {
			delete(plan, "id")
		}
		operation.Plan, _ = json.Marshal(plan)
		_, _, err := decideNFTMutation(principal, "create", operation, nil, time.Now())
		assertNFTStatus(t, err, 422)
	}
}

func TestNFTTaskWireDigestCrossLanguageVector(t *testing.T) {
	digest, err := nftTaskWireDigest([]byte(`{"2":[true,null,2],"10":"<>&\u2028\u2029` + "\u96ea" + `"}`))
	if err != nil || digest != nftRequestDigest([]byte(`{"10":"\u003c\u003e\u0026\u2028\u2029`+"\u96ea"+`","2":[true,null,2]}`)) {
		t.Fatalf("wire canonicalization: %s %v", digest, err)
	}
	for _, raw := range []string{`{"n":9007199254740992}`, `{"n":1.1}`, `{"` + "\u96ea" + `":1}`, `{} {}`} {
		if _, err := nftTaskWireDigest([]byte(raw)); err == nil {
			t.Fatalf("accepted bad encoding %s", raw)
		}
	}
}
func TestNFTMTLSPeerRequiresVerifiedCertificateAndExactSAN(t *testing.T) {
	peer, err := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := url.Parse("spiffe://test-only/wallet")
	certificate := &x509.Certificate{URIs: []*url.URL{uri}}
	request := httptest.NewRequest("POST", NFTTaskJournalPath, nil)
	for _, state := range []*tls.ConnectionState{nil, {HandshakeComplete: true, PeerCertificates: []*x509.Certificate{certificate}}, {HandshakeComplete: false, VerifiedChains: [][]*x509.Certificate{{certificate}}}} {
		request.TLS = state
		request.Header.Set("X-Client-URI", "spiffe://test-only/wallet")
		if _, err := peer.AuthenticatePeer(request); !errors.Is(err, errUserUnauthorized) {
			t.Fatal("unverified TLS or forwarded header authenticated")
		}
	}
	request.TLS = &tls.ConnectionState{HandshakeComplete: true, VerifiedChains: [][]*x509.Certificate{{certificate}}}
	if id, err := peer.AuthenticatePeer(request); err != nil || id != uri.String() {
		t.Fatalf("verified peer rejected: %s %v", id, err)
	}
	foreign, _ := url.Parse("spiffe://test-only/foreign")
	certificate.URIs = []*url.URL{foreign}
	if _, err := peer.AuthenticatePeer(request); err == nil {
		t.Fatal("foreign SAN accepted")
	}
}

type syntheticNFTCapabilityRegistry struct {
	mu     sync.Mutex
	claims NFTTaskCapability
	used   bool
	mutate func(*NFTTaskCapability)
	calls  int
}

func (r *syntheticNFTCapabilityRegistry) ConsumeCapability(_ context.Context, token string, scope NFTTaskCapabilityScope) (NFTTaskCapability, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.used || token != strings.Repeat("t", 40) {
		return NFTTaskCapability{}, errUserForbidden
	}
	r.used = true
	claims := r.claims
	claims.NFTTaskCapabilityScope = scope
	if r.mutate != nil {
		r.mutate(&claims)
	}
	return claims, nil
}
func syntheticNFTTaskRequest(action string, operation nftOperation) *http.Request {
	body, _ := json.Marshal(nftTaskInput{Action: action, Operation: operation})
	request := httptest.NewRequest("POST", NFTTaskJournalPath, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("t", 40))
	uri, _ := url.Parse("spiffe://test-only/wallet")
	request.TLS = &tls.ConnectionState{HandshakeComplete: true, VerifiedChains: [][]*x509.Certificate{{{URIs: []*url.URL{uri}}}}}
	return request
}
func syntheticNFTRegistry(now time.Time) *syntheticNFTCapabilityRegistry {
	return &syntheticNFTCapabilityRegistry{claims: NFTTaskCapability{Principal: syntheticNFTTaskPrincipal(), Wallet: userAuthTestAddress, ChainID: 1, IssuedAtMs: now.UnixMilli(), ExpiresAtMs: now.Add(5 * time.Second).UnixMilli()}}
}
func TestNFTTaskHandlerDefaultUnavailableAndPublicRouteAbsent(t *testing.T) {
	w := httptest.NewRecorder()
	NewNFTTaskJournalHandler(NFTTaskJournalConfig{}).ServeHTTP(w, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
	if w.Code != 503 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unconfigured response %d", w.Code)
	}
	public := newHandler(&rwaService{})
	w = httptest.NewRecorder()
	public.ServeHTTP(w, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
	if w.Code != 404 {
		t.Fatalf("public API unexpectedly has internal route: %d", w.Code)
	}
	if _, _, err := NewNFTTaskJournalServerFromEnvironment(func(string) string { return "" }); err == nil {
		t.Fatal("unconfigured internal server started")
	}
}
func TestNFTTaskHandlerRejectsChangedExpiredReplayedAndUntrustedClaims(t *testing.T) {
	now := time.Now()
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	cases := map[string]func(*NFTTaskCapability){
		"expired":     func(c *NFTTaskCapability) { c.ExpiresAtMs = now.UnixMilli() },
		"future":      func(c *NFTTaskCapability) { c.IssuedAtMs = now.Add(time.Second).UnixMilli() },
		"long lived":  func(c *NFTTaskCapability) { c.ExpiresAtMs = now.Add(31 * time.Second).UnixMilli() },
		"action":      func(c *NFTTaskCapability) { c.Action = "create" },
		"operation":   func(c *NFTTaskCapability) { c.NativeOperationID = "foreign_operation" },
		"body digest": func(c *NFTTaskCapability) { c.RequestDigest = strings.Repeat("a", 64) },
		"plan digest": func(c *NFTTaskCapability) { c.PlanDigest = strings.Repeat("a", 64) },
		"peer":        func(c *NFTTaskCapability) { c.PeerID = "spiffe://test-only/foreign" },
		"principal":   func(c *NFTTaskCapability) { c.Principal.Kind = "session" },
	}
	for name, mutation := range cases {
		t.Run(name, func(t *testing.T) {
			registry := syntheticNFTRegistry(now)
			registry.mutate = mutation
			handler := newNFTTaskJournalHandler(&nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }}, peer, registry, func() time.Time { return now }, true)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
			if w.Code != 403 {
				t.Fatalf("invalid capability status %d", w.Code)
			}
		})
	}
	registry := syntheticNFTRegistry(now)
	handler := newNFTTaskJournalHandler(&nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }}, peer, registry, func() time.Time { return now }, true)
	w := httptest.NewRecorder()
	request := syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"})
	request.TLS = nil
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("bridge", 8))
	handler.ServeHTTP(w, request)
	if w.Code != 401 || registry.calls != 0 {
		t.Fatal("bridge or caller flag established peer authority")
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
	if w.Code != 503 {
		t.Fatalf("valid synthetic auth did not reach unavailable SQL: %d", w.Code)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"}))
	if w.Code != 403 {
		t.Fatal("replay accepted")
	}
	request = syntheticNFTTaskRequest("get", nftOperation{ID: "native_test_only_operation"})
	request.Body = io.NopCloser(strings.NewReader(`{"action":"get","taskPrincipal":{"kind":"task"},"operation":{"id":"native_test_only_operation"}}`))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, request)
	if w.Code != 400 {
		t.Fatal("body principal was accepted")
	}
}
func TestMySQLTaskJournalSharedCASRestartAndPrincipalIsolation(t *testing.T) {
	db, sessionService, _, address := walletAuthIntegrationFixture(t)
	now := time.Now()
	operation := syntheticNFTTaskOperation()
	operation.ID = "task-" + strings.TrimPrefix(address, "0x")
	operation.Wallet = address
	var plan map[string]any
	_ = json.Unmarshal(operation.Plan, &plan)
	plan["operationId"] = operation.ID
	plan["request"].(map[string]any)["account"] = address
	operation.Plan, _ = json.Marshal(plan)
	t.Cleanup(func() { _, _ = db.Exec("DELETE FROM nft_operations WHERE operation_id=?", operation.ID) })
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	call := func(action string, op nftOperation, task NFTTaskPrincipal) *httptest.ResponseRecorder {
		registry := syntheticNFTRegistry(now)
		registry.claims.Wallet = address
		registry.claims.Principal = task
		handler := NewNFTTaskJournalHandler(NFTTaskJournalConfig{DB: db, PeerAuthenticator: peer, CapabilityVerifier: registry, Now: func() time.Time { return now }})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, syntheticNFTTaskRequest(action, op))
		return w
	}
	task := syntheticNFTTaskPrincipal()
	response := call("create", operation, task)
	if response.Code != 200 {
		t.Fatalf("create %d: %s", response.Code, response.Body.String())
	}
	var stored nftOperation
	_ = json.Unmarshal(response.Body.Bytes(), &stored)
	response = call("get", nftOperation{ID: operation.ID}, task)
	if response.Code != 200 {
		t.Fatalf("fresh handler get %d", response.Code)
	}
	foreign := task
	foreign.TaskID = "foreign-task"
	if got := call("get", nftOperation{ID: operation.ID}, foreign); got.Code != 403 {
		t.Fatalf("foreign task read %d", got.Code)
	}
	started := stored
	started.WalletStarted = true
	var wait sync.WaitGroup
	statuses := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() { defer wait.Done(); statuses <- call("update", started, task).Code }()
	}
	wait.Wait()
	close(statuses)
	wins, conflicts := 0, 0
	for status := range statuses {
		if status == 200 {
			wins++
		}
		if status == 409 {
			conflicts++
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("concurrent CAS winners=%d conflicts=%d", wins, conflicts)
	}
	response = call("get", nftOperation{ID: operation.ID}, task)
	_ = json.Unmarshal(response.Body.Bytes(), &stored)
	if stored.Revision != 2 || !stored.WalletStarted {
		t.Fatal("durable wallet claim lost after handler reconstruction")
	}
	tokens := walletAuthIntegrationLogin(t, sessionService, address)
	if got := nftIntegrationRequest(t, sessionService, "get", nftOperation{ID: operation.ID}, tokens.AccessToken); got.Code != 403 {
		t.Fatalf("session adopted task record %d", got.Code)
	}
}

// The isolated runner stops and restarts MySQL between these two fresh Go test
// processes. It proves the wallet-start CAS survives an actual server restart.
func TestMySQLTaskJournalAcrossDatabaseRestart(t *testing.T) {
	phase := os.Getenv("ARTFI_TASK_RESTART_PHASE")
	if phase != "write" && phase != "read" {
		t.Skip("UNVERIFIED: requires the isolated database-restart runner")
	}
	db, err := sql.Open("mysql", os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	task := syntheticNFTTaskPrincipal()
	principal := verifiedNFTPrincipal{wallet: userAuthTestAddress, chainID: 1, task: &task}
	store := &nftOperationStore{db: db, now: time.Now}
	operation := syntheticNFTTaskOperation()
	if phase == "write" {
		stored, err := store.apply(context.Background(), principal, "create", operation)
		if err != nil {
			t.Fatal(err)
		}
		stored.WalletStarted = true
		if _, err = store.apply(context.Background(), principal, "update", stored); err != nil {
			t.Fatal(err)
		}
	} else {
		stored, err := store.apply(context.Background(), principal, "get", nftOperation{ID: operation.ID})
		if err != nil {
			t.Fatal(err)
		}
		if stored.Revision != 2 || !stored.WalletStarted || nftRequestDigest(stored.Plan) != nftRequestDigest(operation.Plan) {
			t.Fatal("immutable claim did not survive database and process restart")
		}
		reset := stored
		reset.WalletStarted = false
		_, err = store.apply(context.Background(), principal, "update", reset)
		assertNFTStatus(t, err, 409)
		if _, err = db.Exec("DELETE FROM nft_operations WHERE operation_id=?", operation.ID); err != nil {
			t.Fatal(err)
		}
	}
}
