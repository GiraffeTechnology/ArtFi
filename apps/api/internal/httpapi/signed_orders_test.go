package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func signedOrderFixture(t *testing.T, kind string) signedOrder {
	t.Helper()
	fields := map[string]any{"seller": "0x2222222222222222222222222222222222222222", "paymentToken": "0x3333333333333333333333333333333333333333", "buyer": "0x0000000000000000000000000000000000000000", "salt": "1", "startsAt": 1000, "endsAt": 2000, "epoch": "0"}
	if kind == "whole" {
		fields["collection"] = "0x4444444444444444444444444444444444444444"
		fields["tokenId"] = "1"
		fields["price"] = "2"
	} else {
		fields["assetToken"] = "0x4444444444444444444444444444444444444444"
		fields["maxAmount"] = "10"
		fields["unitPrice"] = "2"
	}
	input := signedOrder{Kind: kind, ChainID: hoodiChainID, MarketAddress: "0x1111111111111111111111111111111111111111", IntentHash: "0x" + strings.Repeat("a", 64), Signature: "0x", Intent: map[string]json.RawMessage{}}
	for key, value := range fields {
		input.Intent[key], _ = json.Marshal(value)
	}
	return input
}
func TestSignedOrderStrictEnvelope(t *testing.T) {
	for _, kind := range []string{"whole", "fraction"} {
		t.Run(kind, func(t *testing.T) {
			input := signedOrderFixture(t, kind)
			normalized, err := normalizeSignedOrder(input)
			if err != nil || normalized.Kind != kind {
				t.Fatalf("valid envelope: %v", err)
			}
		})
	}
	cases := map[string]func(*signedOrder){
		"wrong chain":        func(o *signedOrder) { o.ChainID = 1 },
		"unknown kind":       func(o *signedOrder) { o.Kind = "option" },
		"extra intent field": func(o *signedOrder) { o.Intent["verified"] = json.RawMessage("true") },
		"missing field":      func(o *signedOrder) { delete(o.Intent, "epoch") },
		"number amount":      func(o *signedOrder) { o.Intent["price"] = json.RawMessage("2") },
		"leading zero":       func(o *signedOrder) { o.Intent["price"] = json.RawMessage(`"02"`) },
		"uint overflow": func(o *signedOrder) {
			o.Intent["price"] = json.RawMessage(`"115792089237316195423570985008687907853269984665640564039457584007913129639936"`)
		},
		"timestamp string":            func(o *signedOrder) { o.Intent["startsAt"] = json.RawMessage(`"1000"`) },
		"timestamp overflow":          func(o *signedOrder) { o.Intent["endsAt"] = json.RawMessage("281474976710656") },
		"timestamp fraction":          func(o *signedOrder) { o.Intent["endsAt"] = json.RawMessage("1000.5") },
		"short address":               func(o *signedOrder) { o.Intent["seller"] = json.RawMessage(`"0x22"`) },
		"odd signature":               func(o *signedOrder) { o.Signature = "0x1" },
		"signature bound":             func(o *signedOrder) { o.Signature = "0x" + strings.Repeat("ab", 8193) },
		"client publication priority": func(o *signedOrder) { o.CreatedAt = "2020-01-01T00:00:00Z" },
	}
	for name, alter := range cases {
		t.Run(name, func(t *testing.T) {
			input := signedOrderFixture(t, "whole")
			alter(&input)
			if _, err := normalizeSignedOrder(input); err == nil {
				t.Fatal("invalid order accepted")
			}
		})
	}
	for _, body := range []string{`{"kind":"whole","verified":true}`, `{} {}`, strings.Repeat("x", 32769)} {
		if _, err := decodeSignedOrder(httptest.NewRequest("POST", "/", strings.NewReader(body))); err == nil {
			t.Fatal("unbounded or extra JSON accepted")
		}
	}
}
func TestSignedOrderQueryBoundary(t *testing.T) {
	for _, query := range []string{"verified=true", "kind=option", "chainId=1", "page=0", "pageSize=101", "page=1&page=2", "tokenId=01", "marketAddress=no", "assetAddress="} {
		if _, _, err := signedOrderFilters(mustQuery(t, query)); err == nil {
			t.Fatalf("bad filter accepted: %s", query)
		}
	}
	where, args, err := signedOrderFilters(mustQuery(t, "kind=whole&chainId=560048&marketAddress=0x1111111111111111111111111111111111111111&assetAddress=0x4444444444444444444444444444444444444444&tokenId=1&page=2&pageSize=20"))
	if err != nil || len(args) != 5 || !strings.Contains(where, "asset_address=?") {
		t.Fatalf("valid scoped query failed: %s %v %v", where, args, err)
	}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	w := httptest.NewRecorder()
	service.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders", nil))
	if w.Code != 503 {
		t.Fatalf("missing DB was represented as empty orders: %d", w.Code)
	}
}
func mustQuery(t *testing.T, value string) url.Values {
	t.Helper()
	v, err := url.ParseQuery(value)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func signedOrdersMySQL(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err = db.Ping(); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DELETE FROM native_signed_orders"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec("DELETE FROM native_signed_orders") })
	return db
}
func TestMySQLSignedOrderPersistenceAndImmutableReplay(t *testing.T) {
	db := signedOrdersMySQL(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	request := httptest.NewRequest(http.MethodPost, "/v1/indexer/signed-orders", nil)
	input := signedOrderFixture(t, "whole")
	stored, status, err := service.persistSignedOrder(request, input)
	if err != nil || status != 201 || stored.CreatedAt == "" {
		t.Fatalf("first durable publication: %d %v", status, err)
	}
	restarted := newRWAService(rwaConfig{}, newMemoryObjectStore())
	restarted.db = db
	replay, replayStatus, err := restarted.persistSignedOrder(request, input)
	if err != nil || replayStatus != 200 || replay.CreatedAt != stored.CreatedAt {
		t.Fatalf("restart/replay changed publication: %d %v", replayStatus, err)
	}
	altered := signedOrderFixture(t, "whole")
	altered.Signature = "0xab"
	if _, _, err = restarted.persistSignedOrder(request, altered); !errors.Is(err, errSignedOrderConflict) {
		t.Fatalf("immutable conflict not rejected: %v", err)
	}
	get := httptest.NewRequest("GET", "/v1/orders/"+input.IntentHash+"?chainId=560048&marketAddress="+input.MarketAddress, nil)
	get.SetPathValue("intentHash", input.IntentHash)
	w := httptest.NewRecorder()
	restarted.getSignedOrder(w, get)
	if w.Code != 200 {
		t.Fatalf("public exact read: %d", w.Code)
	}
	var read signedOrder
	if json.Unmarshal(w.Body.Bytes(), &read) != nil || read.Signature != input.Signature || read.CreatedAt != stored.CreatedAt {
		t.Fatal("stored terms changed")
	}
	wrong := httptest.NewRequest("GET", "/v1/orders/"+input.IntentHash+"?chainId=560048&marketAddress=0x9999999999999999999999999999999999999999", nil)
	wrong.SetPathValue("intentHash", input.IntentHash)
	w = httptest.NewRecorder()
	restarted.getSignedOrder(w, wrong)
	if w.Code != 404 {
		t.Fatalf("different market leaked order: %d", w.Code)
	}
	if _, err = db.ExecContext(context.Background(), "DELETE FROM native_signed_orders"); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	restarted.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatalf("connected empty store is not successful: %d %s", w.Code, w.Body.String())
	}
}

func TestMySQLSessionBoundOrderPublication(t *testing.T) {
	db, auth, _, seller := walletAuthIntegrationFixture(t)
	if _, err := db.Exec("DELETE FROM native_signed_orders"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec("DELETE FROM native_signed_orders") })
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("test-only-order-indexer-key"))
	input := signedOrderFixture(t, "whole")
	input.Intent["seller"], _ = json.Marshal(seller)
	submit := func(access string) int {
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v1/indexer/signed-orders", strings.NewReader(string(raw)))
		r.Header.Set("X-Indexer-Key", "test-only-order-indexer-key")
		if access != "" {
			r.Header.Set("Authorization", "Bearer "+access)
		}
		w := httptest.NewRecorder()
		service.ingestSignedOrder(w, r, auth)
		return w.Code
	}
	if code := submit(""); code != 401 {
		t.Fatalf("unauthenticated publication: %d", code)
	}
	different := walletAuthIntegrationLogin(t, auth, "0x9999999999999999999999999999999999999999")
	t.Cleanup(func() {
		db.Exec("DELETE FROM wallet_user_sessions WHERE wallet_address=?", "0x9999999999999999999999999999999999999999")
		db.Exec("DELETE FROM wallet_user_challenges WHERE wallet_address=?", "0x9999999999999999999999999999999999999999")
	})
	if code := submit(different.AccessToken); code != 403 {
		t.Fatalf("different seller publication: %d", code)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM native_signed_orders").Scan(&count); err != nil || count != 0 {
		t.Fatalf("rejected request wrote orders: %d %v", count, err)
	}
	tokens := walletAuthIntegrationLogin(t, auth, seller)
	if code := submit(tokens.AccessToken); code != 201 {
		t.Fatalf("seller publication: %d", code)
	}
	auth = userAuthTestService(db, auth.now)
	if code := submit(tokens.AccessToken); code != 200 {
		t.Fatalf("restart seller replay: %d", code)
	}
	if err := auth.revokeUserSession(context.Background(), tokens.Session.ID, ""); err != nil {
		t.Fatal(err)
	}
	if code := submit(tokens.AccessToken); code != 401 {
		t.Fatalf("logged-out publication: %d", code)
	}
	w := httptest.NewRecorder()
	service.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders?sellerAddress="+seller, nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), input.IntentHash) {
		t.Fatal("logout incorrectly hid public persisted terms")
	}
}

func TestMySQLSignedOrderPaginationPreservesPublicationOrder(t *testing.T) {
	db := signedOrdersMySQL(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	request := httptest.NewRequest("POST", "/", nil)
	for i := 1; i <= 21; i++ {
		order := signedOrderFixture(t, "fraction")
		order.IntentHash = fmt.Sprintf("0x%064x", i)
		order.Intent["salt"], _ = json.Marshal(fmt.Sprint(i))
		if _, _, err := service.persistSignedOrder(request, order); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	service.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders?kind=fraction&page=2&pageSize=20", nil))
	var page struct {
		Data  []signedOrder `json:"data"`
		Total int           `json:"total"`
		Page  int           `json:"page"`
	}
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || w.Code != 200 || page.Total != 21 || page.Page != 2 || len(page.Data) != 1 || page.Data[0].IntentHash != fmt.Sprintf("0x%064x", 21) {
		t.Fatalf("twenty-first order not reachable: %d %s", w.Code, w.Body.String())
	}
}
