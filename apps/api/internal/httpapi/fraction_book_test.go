package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFractionBookScope(t *testing.T) {
	base := "chainId=560048&marketAddress=0x1111111111111111111111111111111111111111&assetAddress=0x4444444444444444444444444444444444444444&paymentToken=0x3333333333333333333333333333333333333333&at=1500"
	args, at, err := fractionBookScope(mustQuery(t, base))
	if err != nil || len(args) != 4 || at != 1500 {
		t.Fatalf("valid scope rejected: %v", err)
	}
	for _, query := range []string{base + "&sellerAddress=any", base + "&at=1501", strings.Replace(base, "at=1500", "at=01500", 1), strings.Replace(base, "at=1500", "at=281474976710656", 1), strings.Replace(base, "chainId=560048", "chainId=1", 1), strings.Replace(base, "&at=1500", "", 1)} {
		if _, _, err := fractionBookScope(mustQuery(t, query)); err == nil {
			t.Fatalf("invalid scope accepted: %s", query)
		}
	}
}

func TestFractionBookPriceTimeNeutrality(t *testing.T) {
	makeOrder := func(hash, price, published, seller string) signedOrder {
		order := signedOrderFixture(t, "fraction")
		order.IntentHash = "0x" + strings.Repeat(hash, 64)
		order.Intent["unitPrice"], _ = json.Marshal(price)
		order.Intent["seller"], _ = json.Marshal(seller)
		order.CreatedAt = published
		return order
	}
	orders := []signedOrder{
		makeOrder("a", "10", "2026-10-04T00:00:00Z", "0x2222222222222222222222222222222222222222"),
		makeOrder("b", "2", "2026-10-05T00:00:00.000002Z", "0x2222222222222222222222222222222222222222"),
		makeOrder("d", "2", "2026-10-05T00:00:00.000001Z", "0x2222222222222222222222222222222222222222"),
		makeOrder("c", "2", "2026-10-05T00:00:00.000001Z", "0x9999999999999999999999999999999999999999"),
	}
	if err := rankFractionBook(orders); err != nil {
		t.Fatal(err)
	}
	for i, hash := range []string{"c", "d", "b", "a"} {
		if orders[i].IntentHash != "0x"+strings.Repeat(hash, 64) {
			t.Fatalf("priority mismatch at %d", i)
		}
	}
	orders[0].CreatedAt = ""
	if rankFractionBook(orders) == nil {
		t.Fatal("missing immutable time accepted")
	}
}

func TestMySQLFractionBookSnapshot(t *testing.T) {
	db := signedOrdersMySQL(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	request := httptest.NewRequest("POST", "/", nil)
	for i := 1; i <= 5; i++ {
		order := signedOrderFixture(t, "fraction")
		order.IntentHash = fmt.Sprintf("0x%064x", i)
		order.Intent["salt"], _ = json.Marshal(fmt.Sprint(i))
		order.Intent["unitPrice"], _ = json.Marshal(fmt.Sprint(12 - i))
		if i == 3 {
			order.Intent["startsAt"] = json.RawMessage("1501")
		}
		if i == 4 {
			order.Intent["endsAt"] = json.RawMessage("1500")
		}
		if i == 5 {
			order.Intent["paymentToken"], _ = json.Marshal("0x9999999999999999999999999999999999999999")
		}
		if _, _, err := service.persistSignedOrder(request, order); err != nil {
			t.Fatal(err)
		}
	}
	query := "/v1/orders/fraction-book?chainId=560048&marketAddress=0x1111111111111111111111111111111111111111&assetAddress=0x4444444444444444444444444444444444444444&paymentToken=0x3333333333333333333333333333333333333333&at=1500"
	read := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		service.getFractionBook(w, httptest.NewRequest("GET", query, nil))
		return w
	}
	w := read()
	var result struct {
		Data     []signedOrder `json:"data"`
		At       int           `json:"at"`
		LogHash  string        `json:"logHash"`
		Priority string        `json:"priority"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Data) != 2 || result.At != 1500 || len(result.LogHash) != 66 || result.Priority != "price-time-hash" {
		t.Fatalf("invalid snapshot: %d %s", w.Code, w.Body.String())
	}
	if result.Data[0].IntentHash != fmt.Sprintf("0x%064x", 2) {
		t.Fatal("numeric price priority not preserved")
	}
	if replay := read(); replay.Body.String() != w.Body.String() {
		t.Fatal("unchanged log did not replay identically")
	}
	// Exact re-publication cannot buy a new or earlier position in the queue.
	before := result.Data[0].CreatedAt
	order := result.Data[0]
	order.CreatedAt = ""
	if _, _, err := service.persistSignedOrder(request, order); err != nil {
		t.Fatal(err)
	}
	if replay := read(); json.Unmarshal(replay.Body.Bytes(), &result) != nil || result.Data[0].CreatedAt != before {
		t.Fatal("replay changed publication priority")
	}
	// Returning a truncated book could omit the cheapest seller. Refuse it entirely.
	for i := 6; i <= fractionBookLimit+5; i++ {
		order := signedOrderFixture(t, "fraction")
		order.IntentHash = fmt.Sprintf("0x%064x", i)
		order.Intent["salt"], _ = json.Marshal(fmt.Sprint(i))
		if _, _, err := service.persistSignedOrder(request, order); err != nil {
			t.Fatal(err)
		}
	}
	if over := read(); over.Code != 422 {
		t.Fatalf("truncated snapshot offered: %d", over.Code)
	}
}
