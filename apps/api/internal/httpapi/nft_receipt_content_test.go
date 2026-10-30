package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type syntheticNFTReceiptVector struct {
	Name             string                     `json:"name"`
	Binding          NFTReceiptApprovalBinding  `json:"binding"`
	Principal        NFTTaskPrincipal           `json:"principal"`
	Claims           NFTReceiptCapabilityClaims `json:"claims"`
	NativePlan       json.RawMessage            `json:"nativePlan"`
	NativePlanDigest string                     `json:"nativePlanDigest"`
}

func syntheticNFTReceiptVectors(t *testing.T) []syntheticNFTReceiptVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/nft_receipt_content_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Fixture string                      `json:"fixture"`
		Vectors []syntheticNFTReceiptVector `json:"vectors"`
	}
	if json.Unmarshal(raw, &input) != nil || input.Fixture != "SYNTHETIC_NO_REAL_WALLET_OR_SOURCE" || len(input.Vectors) != 3 {
		t.Fatal("synthetic vectors unavailable")
	}
	return input.Vectors
}
func syntheticNFTReceiptPaid(t *testing.T) syntheticNFTReceiptVector {
	t.Helper()
	for _, v := range syntheticNFTReceiptVectors(t) {
		if v.Name == "paid" {
			return v
		}
	}
	t.Fatal("missing paid vector")
	return syntheticNFTReceiptVector{}
}
func syntheticNFTReceiptClaims(v syntheticNFTReceiptVector, now time.Time) NFTTaskCapability {
	return NFTTaskCapability{
		Principal: v.Principal, NFTReceiptCapabilityClaims: v.Claims,
		Wallet: v.Binding.Actor, ChainID: 560048,
		IssuedAtMs: now.UnixMilli(), ExpiresAtMs: now.Add(5 * time.Second).UnixMilli(),
	}
}
func syntheticNFTReceiptOperation(t *testing.T, v syntheticNFTReceiptVector) nftOperation {
	t.Helper()
	var identity struct {
		OperationID string `json:"operationId"`
	}
	if json.Unmarshal(v.NativePlan, &identity) != nil {
		t.Fatal("synthetic native identity")
	}
	return nftOperation{
		ID: identity.OperationID, Wallet: v.Binding.Actor, ChainID: 560048,
		RequestHash: v.NativePlanDigest, Status: "awaiting-wallet",
		Plan: append(json.RawMessage(nil), v.NativePlan...),
	}
}
func syntheticNFTReceiptMap(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil {
		t.Fatal("synthetic JSON")
	}
	return result
}
func syntheticNFTReceiptJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func TestNFTReceiptContentSharedThreePhaseVectorsAndNativeCopies(t *testing.T) {
	for _, v := range syntheticNFTReceiptVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			content, err := CompareNFTReceiptApprovalContent(v.NativePlan, v.Binding, v.Principal, v.Claims)
			if err != nil || content.ReceiptPlanDigest() != v.Claims.ReceiptPlanDigest ||
				content.ReceiptJournalBindingHash() != v.Claims.ReceiptJournalBindingHash ||
				content.NativePlanDigest() != v.NativePlanDigest || !bytes.Equal(content.NativePlan(), v.NativePlan) {
				t.Fatal("content contract differs from independent shared vector")
			}
			copy := content.NativePlan()
			copy[0] = 'x'
			business := content.Business()
			business[0] = 'x'
			v.NativePlan[0] = 'x'
			if content.NativePlan()[0] != '{' || content.Business()[0] != '{' {
				t.Fatal("caller mutation escaped the validated snapshot")
			}
		})
	}
}
func TestNFTReceiptContentRejectsAllBindingAndClaimDrift(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	bindings := []NFTReceiptApprovalBinding{}
	for _, field := range []string{"tenant", "origin", "taskId", "actor", "escrow", "runtime"} {
		b := v.Binding
		switch field {
		case "tenant":
			b.Tenant = "different-example"
		case "origin":
			b.Origin = "https://other.example:9445"
		case "taskId":
			b.TaskID = "different-example-task"
		case "actor":
			b.Actor = "0x" + strings.Repeat("c", 40)
		case "escrow":
			b.Escrow = "0x" + strings.Repeat("4", 40)
		case "runtime":
			b.RuntimeCodeHash = "0x" + strings.Repeat("f", 64)
		}
		bindings = append(bindings, b)
	}
	for _, b := range bindings {
		if _, err := CompareNFTReceiptApprovalContent(v.NativePlan, b, v.Principal, v.Claims); err == nil {
			t.Fatal("foreign installation binding accepted")
		}
	}
	for _, mutate := range []func(*NFTReceiptCapabilityClaims){
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptPhase = "funded" },
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptNonce = "02" },
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptNonce = "9007199254740992" },
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptPlanDigest = "0x" + strings.Repeat("c", 64) },
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptJournalBindingHash = "0x" + strings.Repeat("d", 64) },
		func(c *NFTReceiptCapabilityClaims) { c.ReceiptJournalBindingHash = "" },
	} {
		c := v.Claims
		mutate(&c)
		if _, err := CompareNFTReceiptApprovalContent(v.NativePlan, v.Binding, v.Principal, c); err == nil {
			t.Fatal("foreign or malformed receipt claims accepted")
		}
	}
}
func TestNFTReceiptContentRejectsDuplicateAliasNullUnknownAndSignedFields(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	raw := string(v.NativePlan)
	cases := []string{
		strings.Replace(raw, `"kind": "transaction"`, `"kind":"transaction","kind":"transaction"`, 1),
		strings.Replace(raw, `"taskId"`, `"TaskId"`, 1),
		strings.Replace(raw, `"schemaVersion": 1`, `"schemaVersion":null`, 1),
		strings.Replace(raw, `"price": "100"`, `"price":"100","unexpected":"data"`, 1),
		strings.Replace(raw, `"account"`, `"signature"`, 1),
		raw + " {}",
	}
	for i, candidate := range cases {
		if candidate == raw {
			t.Fatalf("case %d did not change vector", i)
		}
		if _, err := CompareNFTReceiptApprovalContent([]byte(candidate), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatalf("invalid receipt JSON accepted in case %d", i)
		}
	}
}
func TestNFTReceiptContentKeepsNativePrincipalAndIDIndependent(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	other := v.Principal
	other.GrantReference = "grant:other-example"
	if _, err := CompareNFTReceiptApprovalContent(v.NativePlan, v.Binding, other, v.Claims); err == nil {
		t.Fatal("foreign principal accepted")
	}
	body := syntheticNFTReceiptMap(t, v.NativePlan)
	body["operationId"] = "native_" + strings.Repeat("0", 64)
	if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
		t.Fatal("non-derived native operation identity accepted")
	}
	for _, field := range []string{"taskId", "taskDigest", "executorDigest", "grantReference", "grantPolicyVersion", "operationId"} {
		body = syntheticNFTReceiptMap(t, v.NativePlan)
		principal := body["taskPrincipal"].(map[string]any)
		delete(principal, field)
		if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatalf("incomplete native principal accepted: %s", field)
		}
	}
}
func TestNFTReceiptContentRejectsChangedSaleAndCorrespondence(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	for _, field := range []string{"price", "tokenId", "salt", "epoch", "startsAt", "endsAt", "seller", "buyer", "collection", "paymentToken"} {
		body := syntheticNFTReceiptMap(t, v.NativePlan)
		sale := body["wholeReceipt"].(map[string]any)["sale"].(map[string]any)
		switch field {
		case "startsAt":
			sale[field] = 1001
		case "endsAt":
			sale[field] = 2001
		case "seller", "buyer", "collection", "paymentToken":
			sale[field] = "0x" + strings.Repeat("c", 40)
		default:
			sale[field] = "101"
		}
		if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatalf("changed sale accepted: %s", field)
		}
	}
	for _, field := range []string{"settlementId", "assetRecordHash", "oracleSourceId", "requestHash", "executionReferenceHash", "previousSegment", "oldCertificateHash", "warehouseReceiptHash"} {
		body := syntheticNFTReceiptMap(t, v.NativePlan)
		c := body["wholeReceipt"].(map[string]any)["correspondence"].(map[string]any)
		c[field] = "0x" + strings.Repeat("f", 64)
		if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatalf("changed correspondence accepted: %s", field)
		}
	}
}
func TestNFTReceiptContentRejectsBoundsAndPhaseProofMixing(t *testing.T) {
	for _, v := range syntheticNFTReceiptVectors(t) {
		body := syntheticNFTReceiptMap(t, v.NativePlan)
		r := body["wholeReceipt"].(map[string]any)
		if v.Name == "registered" {
			delete(r, "kitRegistration")
		} else {
			r["kitRegistration"] = map[string]any{"version": "2", "proofHash": "0x" + strings.Repeat("a", 64)}
		}
		if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatal("proof/phase mismatch accepted")
		}
	}
	v := syntheticNFTReceiptPaid(t)
	for _, bad := range []any{"0", "01", "-1", "115792089237316195423570985008687907853269984665640564039457584007913129639936", 100} {
		body := syntheticNFTReceiptMap(t, v.NativePlan)
		body["wholeReceipt"].(map[string]any)["sale"].(map[string]any)["price"] = bad
		if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
			t.Fatal("invalid uint256 string accepted")
		}
	}
	body := syntheticNFTReceiptMap(t, v.NativePlan)
	body["wholeReceipt"].(map[string]any)["sale"].(map[string]any)["endsAt"] = 281474976710656
	if _, err := CompareNFTReceiptApprovalContent(syntheticNFTReceiptJSON(t, body), v.Binding, v.Principal, v.Claims); err == nil {
		t.Fatal("uint48 overflow accepted")
	}
}
func TestNFTReceiptContentNormalizationDoesNotRewriteNativePlan(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	body := syntheticNFTReceiptMap(t, v.NativePlan)
	body["request"].(map[string]any)["account"] = "0x" + strings.Repeat("B", 40)
	body["wholeReceipt"].(map[string]any)["sale"].(map[string]any)["buyer"] = "0x" + strings.Repeat("B", 40)
	raw := syntheticNFTReceiptJSON(t, body)
	content, err := CompareNFTReceiptApprovalContent(raw, v.Binding, v.Principal, v.Claims)
	if err != nil || !bytes.Equal(content.NativePlan(), raw) || content.NativePlanDigest() == v.NativePlanDigest {
		t.Fatal("canonical content and exact native plan were conflated")
	}
}
func TestNFTReceiptStoreChecksEveryReadAndIdempotentCreate(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	now := time.Now()
	context, err := newVerifiedNFTReceiptContext(v.Binding, syntheticNFTReceiptClaims(v, now))
	if err != nil {
		t.Fatal(err)
	}
	owner := verifiedNFTPrincipal{wallet: v.Binding.Actor, chainID: 560048, task: &v.Principal, receipt: context}
	next := syntheticNFTReceiptOperation(t, v)
	stored, write, err := decideNFTMutation(owner, "create", next, nil, now)
	if err != nil || !write || stored.Revision != 1 {
		t.Fatal("receipt create refused")
	}
	if _, write, err = decideNFTMutation(owner, "create", next, &stored, now); err != nil || write {
		t.Fatal("idempotent receipt changed")
	}
	if _, _, err = decideNFTMutation(owner, "get", nftOperation{ID: stored.ID}, &stored, now); err != nil {
		t.Fatal(err)
	}
	without := owner
	without.receipt = nil
	if _, _, err = decideNFTMutation(without, "get", nftOperation{ID: stored.ID}, &stored, now); err == nil {
		t.Fatal("missing receipt context adopted row")
	}
	corrupt := stored
	corrupt.RequestHash = strings.Repeat("0", 64)
	if _, _, err = decideNFTMutation(owner, "get", nftOperation{ID: stored.ID}, &corrupt, now); err == nil {
		t.Fatal("corrupt native digest returned")
	}
	listing := syntheticNFTTaskOperation()
	if owner.owns(listing) {
		t.Fatal("receipt context downgraded to listing")
	}
}
func TestNFTReceiptStoreRefusesSessionDowngradeBeforeRecovery(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	now := time.Now()
	session := verifiedNFTPrincipal{wallet: v.Binding.Actor, chainID: 560048, sessionID: "example-session"}
	for _, key := range []string{"wholeReceipt", "WholeReceipt", "wholereceipt"} {
		for _, empty := range []bool{false, true} {
			name := key
			if empty {
				name += "/null"
			}
			t.Run(name, func(t *testing.T) {
				row := syntheticNFTReceiptOperation(t, v)
				plan := syntheticNFTReceiptMap(t, row.Plan)
				receipt := plan["wholeReceipt"]
				delete(plan, "taskPrincipal")
				delete(plan, "wholeReceipt")
				plan["sessionId"] = session.sessionID
				if empty {
					receipt = nil
				}
				plan[key] = receipt
				row.Plan = syntheticNFTReceiptJSON(t, plan)
				row.RequestHash = nftRequestDigest(row.Plan)
				stored := row
				stored.Revision = 1
				if session.owns(stored) {
					t.Fatal("session adopted receipt after task principal removal")
				}
				if _, write, err := decideNFTMutation(session, "create", row, nil, now); err == nil || write {
					t.Fatal("session created a downgraded receipt")
				}
				if _, write, err := decideNFTMutation(session, "create", row, &stored, now); err == nil || write {
					t.Fatal("session recovered receipt through idempotent create")
				}
				if _, write, err := decideNFTMutation(session, "get", nftOperation{ID: row.ID}, &stored, now); err == nil || write {
					t.Fatal("session read a downgraded receipt")
				}
			})
		}
	}
	// Ordinary session-owned NFT records retain create and refresh recovery.
	row := syntheticNFTReceiptOperation(t, v)
	row.Plan = syntheticNFTReceiptJSON(t, map[string]any{
		"sessionId": session.sessionID, "operationId": row.ID, "chainId": session.chainID,
	})
	row.RequestHash = nftRequestDigest(row.Plan)
	stored, write, err := decideNFTMutation(session, "create", row, nil, now)
	if err != nil || !write {
		t.Fatal("ordinary session create was blocked")
	}
	if _, write, err := decideNFTMutation(session, "get", nftOperation{ID: row.ID}, &stored, now); err != nil || write {
		t.Fatal("ordinary session refresh recovery was blocked")
	}
}

func TestNFTReceiptStoreKeepsCASStartedMarkerAndReorgRules(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	now := time.Now()
	bound, err := newVerifiedNFTReceiptContext(v.Binding, syntheticNFTReceiptClaims(v, now))
	if err != nil {
		t.Fatal(err)
	}
	owner := verifiedNFTPrincipal{wallet: v.Binding.Actor, chainID: 560048, task: &v.Principal, receipt: bound}
	stored, _, err := decideNFTMutation(owner, "create", syntheticNFTReceiptOperation(t, v), nil, now)
	if err != nil {
		t.Fatal(err)
	}
	started := stored
	started.WalletStarted = true
	started, _, err = decideNFTMutation(owner, "update", started, &stored, now)
	if err != nil || started.Revision != 2 {
		t.Fatal("receipt wallet-start CAS")
	}
	if _, _, err = decideNFTMutation(owner, "update", stored, &started, now); err == nil {
		t.Fatal("stale revision/reset accepted")
	}
	reset := started
	reset.WalletStarted = false
	if _, _, err = decideNFTMutation(owner, "update", reset, &started, now); err == nil {
		t.Fatal("wallet-start reset accepted")
	}
	confirmed := started
	confirmed.Status = "confirmed"
	confirmed.TransactionHash = "0x" + strings.Repeat("f", 64)
	pending := confirmed
	pending.Status = "pending"
	if _, write, err := decideNFTMutation(owner, "update", pending, &confirmed, now); err != nil || !write {
		t.Fatal("bounded receipt reorg transition refused")
	}
	pending.TransactionHash = "0x" + strings.Repeat("a", 64)
	if _, _, err := decideNFTMutation(owner, "update", pending, &confirmed, now); err == nil {
		t.Fatal("known receipt transaction replaced")
	}
}

type syntheticNFTReceiptAuthority func(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error)

func (a syntheticNFTReceiptAuthority) ResolveReceipt(ctx context.Context, c NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
	return a(ctx, c)
}
func syntheticNFTReceiptRequest(t *testing.T, action string, operation nftOperation) *http.Request {
	t.Helper()
	r := syntheticNFTTaskRequest(action, operation)
	var op any = operation
	if action == "get" {
		op = map[string]any{"id": operation.ID}
	}
	r.Body = io.NopCloser(bytes.NewReader(syntheticNFTReceiptJSON(t, map[string]any{"action": action, "operation": op})))
	return r
}
func TestNFTReceiptHandlerRequiresExplicitAuthorityAfterActualPeerAndConsume(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	now := time.Now()
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	newRegistry := func() *syntheticNFTCapabilityRegistry {
		return &syntheticNFTCapabilityRegistry{claims: syntheticNFTReceiptClaims(v, now)}
	}
	store := &nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }}
	calls := 0
	authority := syntheticNFTReceiptAuthority(func(ctx context.Context, c NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || deadline.UnixMilli() != c.ExpiresAtMs {
			t.Fatal("source read lost consumed-capability deadline")
		}
		return v.Binding, nil
	})
	w := httptest.NewRecorder()
	newNFTTaskJournalHandler(store, peer, newRegistry(), func() time.Time { return now }, true).ServeHTTP(w, syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, v)))
	if w.Code != 503 || calls != 0 {
		t.Fatal("missing receipt authority opened route")
	}
	registry := newRegistry()
	h := newNFTTaskJournalHandlerWithReceiptAuthority(store, peer, registry, func() time.Time { return now }, true, authority)
	r := syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, v))
	r.TLS = nil
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 || registry.calls != 0 || calls != 0 {
		t.Fatal("source read preceded peer authentication")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, v)))
	if w.Code != 503 || calls != 1 || registry.calls != 1 {
		t.Fatal("explicit synthetic source did not reach unavailable SQL")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, v)))
	if w.Code != 403 || calls != 1 {
		t.Fatal("consumed receipt capability replayed")
	}
}
func TestNFTReceiptHandlerWithholdsExpiredOrFailedSourceResolution(t *testing.T) {
	v := syntheticNFTReceiptPaid(t)
	for _, mode := range []string{"expired", "error", "foreign actor"} {
		t.Run(mode, func(t *testing.T) {
			now := time.Now()
			registry := &syntheticNFTCapabilityRegistry{claims: syntheticNFTReceiptClaims(v, now)}
			peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
			calls := 0
			authority := syntheticNFTReceiptAuthority(func(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
				calls++
				binding := v.Binding
				switch mode {
				case "expired":
					now = now.Add(10 * time.Second)
				case "error":
					return binding, errors.New("synthetic private source diagnostic")
				case "foreign actor":
					binding.Actor = "0x" + strings.Repeat("c", 40)
				}
				return binding, nil
			})
			h := newNFTTaskJournalHandlerWithReceiptAuthority(&nftOperationStore{db: unavailableUserAuthDB{}, now: func() time.Time { return now }}, peer, registry, func() time.Time { return now }, true, authority)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, syntheticNFTReceiptRequest(t, "get", syntheticNFTReceiptOperation(t, v)))
			if w.Code != 503 || calls != 1 || strings.Contains(w.Body.String(), "diagnostic") {
				t.Fatal("failed or expired source escaped")
			}
		})
	}
}
func TestNFTReceiptOperationEnvelopeRejectsAliasesDuplicatesAndDowngrades(t *testing.T) {
	id := "native_example_operation"
	valid := `{"action":"get","operation":{"id":"` + id + `"}}`
	if !validNFTReceiptJournalInput([]byte(valid), "get") {
		t.Fatal("ID-only read refused")
	}
	for _, raw := range []string{
		strings.Replace(valid, `"action"`, `"Action"`, 1),
		strings.Replace(valid, `"id":"`+id+`"`, `"id":"`+id+`","id":"`+id+`"`, 1),
		strings.Replace(valid, `"id":"`+id+`"`, `"id":"`+id+`","plan":{}`, 1),
		strings.Replace(valid, `"id":"`+id+`"`, `"id":null`, 1),
	} {
		if validNFTReceiptJournalInput([]byte(raw), "get") {
			t.Fatal("ambiguous receipt envelope accepted")
		}
	}
}

func TestMySQLReceiptAuthorityJournalCASAndReconstructedRead(t *testing.T) {
	// Real isolated MySQL repository, with synthetic peer/capability/source
	// authority only. This is not institutional or public-chain acceptance.
	db, _, _, unique := walletAuthIntegrationFixture(t)
	v := syntheticNFTReceiptPaid(t)
	v.Principal.GrantReference = "grant:example_" + strings.TrimPrefix(unique, "0x")
	body := syntheticNFTReceiptMap(t, v.NativePlan)
	body["taskPrincipal"] = v.Principal
	binding := map[string]any{
		"taskId": v.Principal.TaskID, "taskDigest": v.Principal.TaskDigest,
		"executorDigest": v.Principal.ExecutorDigest, "grantReference": v.Principal.GrantReference,
		"grantPolicyVersion": v.Principal.GrantPolicyVersion, "operationId": v.Principal.OperationID,
	}
	digest, err := nftTaskWireDigest(syntheticNFTReceiptJSON(t, binding))
	if err != nil {
		t.Fatal(err)
	}
	body["operationId"] = "native_" + digest
	v.NativePlan = syntheticNFTReceiptJSON(t, body)
	v.NativePlanDigest, err = nftTaskWireDigest(v.NativePlan)
	if err != nil {
		t.Fatal(err)
	}
	operation := syntheticNFTReceiptOperation(t, v)
	t.Cleanup(func() { _, _ = db.Exec("DELETE FROM nft_operations WHERE operation_id=?", operation.ID) })
	peer, _ := NewNFTMTLSPeerAuthenticator([]string{"spiffe://test-only/wallet"})
	call := func(action string, op nftOperation, authority NFTReceiptAuthority) *httptest.ResponseRecorder {
		now := time.Now()
		registry := &syntheticNFTCapabilityRegistry{claims: syntheticNFTReceiptClaims(v, now)}
		handler := NewNFTTaskJournalHandler(NFTTaskJournalConfig{
			DB: db, PeerAuthenticator: peer, CapabilityVerifier: registry,
			ReceiptAuthority: authority, Now: func() time.Time { return now },
		})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, syntheticNFTReceiptRequest(t, action, op))
		return w
	}
	authority := syntheticNFTReceiptAuthority(func(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error) { return v.Binding, nil })
	w := call("create", operation, authority)
	if w.Code != 200 {
		t.Fatalf("receipt create status %d", w.Code)
	}
	var stored nftOperation
	if json.Unmarshal(w.Body.Bytes(), &stored) != nil || stored.Revision != 1 {
		t.Fatal("receipt row missing")
	}
	if got := call("get", nftOperation{ID: stored.ID}, nil); got.Code != 503 {
		t.Fatal("reconstruction without source authority enabled receipt")
	}
	started := stored
	started.WalletStarted = true
	if got := call("update", started, authority); got.Code != 200 {
		t.Fatalf("receipt start CAS status %d", got.Code)
	}
	if got := call("update", started, authority); got.Code != 409 {
		t.Fatalf("receipt stale CAS status %d", got.Code)
	}
	w = call("get", nftOperation{ID: stored.ID}, authority)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &stored) != nil || !stored.WalletStarted || stored.Revision != 2 {
		t.Fatal("receipt claim lost across fresh handler")
	}
	foreign := syntheticNFTReceiptAuthority(func(context.Context, NFTTaskCapability) (NFTReceiptApprovalBinding, error) {
		b := v.Binding
		b.Origin = "https://other.example:9445"
		return b, nil
	})
	if got := call("get", nftOperation{ID: stored.ID}, foreign); got.Code != 403 {
		t.Fatalf("foreign source binding read status %d", got.Code)
	}
}
