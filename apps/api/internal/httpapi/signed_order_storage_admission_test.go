package httpapi

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const storageAdmissionMarket = "0x1111111111111111111111111111111111111111"
const storageAdmissionSeller = "0x2222222222222222222222222222222222222222"
const storageAdmissionPayment = "0x3333333333333333333333333333333333333333"
const storageAdmissionAsset = "0x4444444444444444444444444444444444444444"
const storageAdmissionOther = "0x9999999999999999999999999999999999999999"

var storageAdmissionTime = time.Date(2026, 10, 19, 0, 0, 0, 123000000, time.UTC)

func storageAdmissionOrder(kind string) signedOrder {
	fields := map[string]any{"seller": storageAdmissionSeller, "buyer": "0x0000000000000000000000000000000000000000", "paymentToken": storageAdmissionPayment, "salt": "1", "epoch": "0", "startsAt": 1000, "endsAt": 2000}
	if kind == "whole" {
		fields["collection"] = storageAdmissionAsset
		fields["tokenId"] = "1"
		fields["price"] = "2"
	} else {
		fields["assetToken"] = storageAdmissionAsset
		fields["maxAmount"] = "10"
		fields["unitPrice"] = "2"
	}
	order := signedOrder{Kind: kind, ChainID: 560048, MarketAddress: storageAdmissionMarket, IntentHash: "0x" + strings.Repeat("a", 64), Signature: "0x", Intent: map[string]json.RawMessage{}}
	for k, v := range fields {
		order.Intent[k], _ = json.Marshal(v)
	}
	return order
}
func storageAdmissionBytes(t *testing.T, order signedOrder) []byte {
	t.Helper()
	b, e := json.Marshal(order)
	if e != nil {
		t.Fatal(e)
	}
	return b
}

type storageAdmissionRecord struct {
	raw     []byte
	created time.Time
}
type storageAdmissionConnector struct {
	records []storageAdmissionRecord
	failure error
	queries []string
	args    [][]driver.NamedValue
}

func (c *storageAdmissionConnector) Connect(context.Context) (driver.Conn, error) {
	return &storageAdmissionConn{c}, nil
}
func (c *storageAdmissionConnector) Driver() driver.Driver { return storageAdmissionDriver{} }

type storageAdmissionDriver struct{}

func (storageAdmissionDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("no external database")
}

type storageAdmissionConn struct{ owner *storageAdmissionConnector }

func (*storageAdmissionConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("no prepared writes")
}
func (*storageAdmissionConn) Close() error              { return nil }
func (*storageAdmissionConn) Begin() (driver.Tx, error) { return nil, errors.New("no writes") }
func (c *storageAdmissionConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	c.owner.queries = append(c.owner.queries, q)
	c.owner.args = append(c.owner.args, append([]driver.NamedValue(nil), args...))
	if c.owner.failure != nil {
		return nil, c.owner.failure
	}
	if strings.HasPrefix(q, "SELECT COUNT(*)") {
		return &storageAdmissionRows{count: true, total: len(c.owner.records)}, nil
	}
	return &storageAdmissionRows{records: c.owner.records}, nil
}

type storageAdmissionRows struct {
	records []storageAdmissionRecord
	index   int
	count   bool
	total   int
}

func (r *storageAdmissionRows) Columns() []string {
	if r.count {
		return []string{"count"}
	}
	return []string{"envelope_json", "created_at"}
}
func (*storageAdmissionRows) Close() error { return nil }
func (r *storageAdmissionRows) Next(values []driver.Value) error {
	if r.count {
		if r.index > 0 {
			return io.EOF
		}
		values[0] = int64(r.total)
		r.index++
		return nil
	}
	if r.index >= len(r.records) {
		return io.EOF
	}
	record := r.records[r.index]
	r.index++
	values[0] = record.raw
	values[1] = record.created
	return nil
}
func storageAdmissionService(t *testing.T, records ...storageAdmissionRecord) (*rwaService, *storageAdmissionConnector) {
	t.Helper()
	connector := &storageAdmissionConnector{records: records}
	db := sql.OpenDB(connector)
	t.Cleanup(func() { _ = db.Close() })
	return &rwaService{db: db}, connector
}
func storageAdmissionRead(service *rwaService, which string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	query := "chainId=560048&marketAddress=" + storageAdmissionMarket
	switch which {
	case "detail":
		r := httptest.NewRequest("GET", "/v1/orders/hash?"+query, nil)
		r.SetPathValue("intentHash", "0x"+strings.Repeat("a", 64))
		service.getSignedOrder(w, r)
	case "list":
		service.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders?"+query+"&kind=fraction&assetAddress="+storageAdmissionAsset+"&sellerAddress="+storageAdmissionSeller, nil))
	case "book":
		service.getFractionBook(w, httptest.NewRequest("GET", "/v1/orders/fraction-book?"+query+"&assetAddress="+storageAdmissionAsset+"&paymentToken="+storageAdmissionPayment+"&at=1500", nil))
	default:
		panic(which)
	}
	return w
}

func TestStoredOrderRegressionMalformedEnvelope(t *testing.T) {
	valid := storageAdmissionBytes(t, storageAdmissionOrder("fraction"))
	cases := map[string][]byte{"unknown outer": []byte(strings.TrimSuffix(string(valid), "}") + `,"private":"private-topology"}`), "duplicate outer": []byte(strings.Replace(string(valid), `"chainId":560048`, `"chainId":1,"chainId":560048`, 1)), "duplicate intent": []byte(strings.Replace(string(valid), `"unitPrice":"2"`, `"unitPrice":"1","unitPrice":"2"`, 1)), "missing intent": []byte(strings.Replace(string(valid), `"maxAmount":"10",`, "", 1)), "numeric amount": []byte(strings.Replace(string(valid), `"maxAmount":"10"`, `"maxAmount":10`, 1)), "client timestamp": []byte(strings.TrimSuffix(string(valid), "}") + `,"createdAt":"2000-01-01T00:00:00Z"}`)}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			for _, which := range []string{"list", "detail", "book"} {
				service, _ := storageAdmissionService(t, storageAdmissionRecord{raw, storageAdmissionTime})
				w := storageAdmissionRead(service, which)
				if w.Code != 503 {
					t.Fatalf("%s returned malformed order: %d", which, w.Code)
				}
				if strings.Contains(w.Body.String(), "private-topology") {
					t.Fatal("stored private diagnostic leaked")
				}
			}
		})
	}
}
func TestStoredOrderRegressionDetailScope(t *testing.T) {
	for name, alter := range map[string]func(*signedOrder){"market": func(o *signedOrder) { o.MarketAddress = storageAdmissionOther }, "hash": func(o *signedOrder) { o.IntentHash = "0x" + strings.Repeat("b", 64) }, "chain": func(o *signedOrder) { o.ChainID = 1 }} {
		t.Run(name, func(t *testing.T) {
			o := storageAdmissionOrder("fraction")
			alter(&o)
			service, _ := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, o), storageAdmissionTime})
			if w := storageAdmissionRead(service, "detail"); w.Code != 503 {
				t.Fatalf("different %s returned: %d", name, w.Code)
			}
		})
	}
}
func TestStoredOrderRegressionListScope(t *testing.T) {
	for name, alter := range map[string]func(*signedOrder){"market": func(o *signedOrder) { o.MarketAddress = storageAdmissionOther }, "seller": func(o *signedOrder) { o.Intent["seller"], _ = json.Marshal(storageAdmissionOther) }, "asset": func(o *signedOrder) { o.Intent["assetToken"], _ = json.Marshal(storageAdmissionOther) }, "kind": func(o *signedOrder) { *o = storageAdmissionOrder("whole") }} {
		t.Run(name, func(t *testing.T) {
			o := storageAdmissionOrder("fraction")
			alter(&o)
			service, _ := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, o), storageAdmissionTime})
			if w := storageAdmissionRead(service, "list"); w.Code != 503 {
				t.Fatalf("different %s returned: %d", name, w.Code)
			}
		})
	}
}
func TestStoredOrderRegressionBookScope(t *testing.T) {
	for name, alter := range map[string]func(*signedOrder){"market": func(o *signedOrder) { o.MarketAddress = storageAdmissionOther }, "asset": func(o *signedOrder) { o.Intent["assetToken"], _ = json.Marshal(storageAdmissionOther) }, "payment": func(o *signedOrder) { o.Intent["paymentToken"], _ = json.Marshal(storageAdmissionOther) }, "not started": func(o *signedOrder) { o.Intent["startsAt"] = json.RawMessage("1501") }, "ended": func(o *signedOrder) { o.Intent["endsAt"] = json.RawMessage("1500") }} {
		t.Run(name, func(t *testing.T) {
			o := storageAdmissionOrder("fraction")
			alter(&o)
			service, _ := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, o), storageAdmissionTime})
			if w := storageAdmissionRead(service, "book"); w.Code != 503 {
				t.Fatalf("different %s returned: %d", name, w.Code)
			}
		})
	}
}
func TestStoredOrderAdmissionValidReadsAndCanonicalTime(t *testing.T) {
	for _, which := range []string{"list", "detail", "book"} {
		t.Run(which, func(t *testing.T) {
			o := storageAdmissionOrder("fraction")
			service, driver := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, o), storageAdmissionTime.In(time.FixedZone("offset", 3600))})
			w := storageAdmissionRead(service, which)
			if w.Code != 200 || !strings.Contains(w.Body.String(), storageAdmissionTime.Format(time.RFC3339Nano)) {
				t.Fatalf("valid terms/time unavailable: %d %s", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("public snapshot cached")
			}
			if len(driver.queries) == 0 {
				t.Fatal("actual handler never queried storage")
			}
		})
	}
}
func TestStoredOrderAdmissionMissingTimeIsNotPriority(t *testing.T) {
	for _, which := range []string{"detail", "list", "book"} {
		service, _ := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, storageAdmissionOrder("fraction")), time.Time{}})
		if w := storageAdmissionRead(service, which); w.Code != 503 {
			t.Fatalf("missing publication time accepted by %s", which)
		}
	}
}
func TestStoredOrderAdmissionEmptyAndFailureStayDistinct(t *testing.T) {
	for _, which := range []string{"detail", "list", "book"} {
		service, driver := storageAdmissionService(t)
		w := storageAdmissionRead(service, which)
		expected := 200
		if which == "detail" {
			expected = 404
		}
		if w.Code != expected {
			t.Fatalf("empty %s: %d", which, w.Code)
		}
		if which != "detail" && !strings.Contains(w.Body.String(), `"data":[]`) {
			t.Fatal("empty response missing exact empty data")
		}
		driver.failure = errors.New("private-database-key")
		w = storageAdmissionRead(service, which)
		if w.Code != 503 || strings.Contains(w.Body.String(), "private-database-key") {
			t.Fatalf("failed storage exposed or shown empty: %d", w.Code)
		}
	}
}
func TestStoredOrderAdmissionDuplicateJSONAtIngest(t *testing.T) {
	for _, kind := range []string{"whole", "fraction"} {
		raw := storageAdmissionBytes(t, storageAdmissionOrder(kind))
		cases := []string{strings.Replace(string(raw), `"kind":"`+kind+`"`, `"kind":"`+kind+`","kind":"`+kind+`"`, 1), strings.Replace(string(raw), `"seller":"`+storageAdmissionSeller+`"`, `"seller":"`+storageAdmissionSeller+`","\u0073eller":"`+storageAdmissionSeller+`"`, 1), string(raw) + ` {}`, `null`}
		for i, value := range cases {
			t.Run(fmt.Sprintf("%s-%d", kind, i), func(t *testing.T) {
				if _, err := decodeSignedOrder(httptest.NewRequest("POST", "/", strings.NewReader(value))); err == nil {
					t.Fatal("ambiguous or non-object authorization admitted")
				}
			})
		}
	}
}
func TestStoredOrderAdmissionRankingKeepsSellerNeutrality(t *testing.T) {
	orders := []signedOrder{}
	for i, price := range []string{"10", "2", "2"} {
		o := storageAdmissionOrder("fraction")
		o.IntentHash = fmt.Sprintf("0x%064x", 3-i)
		o.Intent["unitPrice"], _ = json.Marshal(price)
		if i == 2 {
			o.Intent["seller"], _ = json.Marshal(storageAdmissionOther)
		}
		o.CreatedAt = storageAdmissionTime.Format(time.RFC3339Nano)
		orders = append(orders, o)
	}
	if err := rankFractionBook(orders); err != nil {
		t.Fatal(err)
	}
	for i, id := range []int{1, 2, 3} {
		if orders[i].IntentHash != fmt.Sprintf("0x%064x", id) {
			t.Fatal("price/time/hash priority changed")
		}
	}
	before := orders[0].IntentHash
	orders[0].Intent["seller"], _ = json.Marshal(storageAdmissionSeller)
	if err := rankFractionBook(orders); err != nil || orders[0].IntentHash != before {
		t.Fatal("seller identity changed priority")
	}
}
func TestStoredOrderAdmissionScopeMatchingUsesWholeToken(t *testing.T) {
	o := storageAdmissionOrder("whole")
	service, _ := storageAdmissionService(t, storageAdmissionRecord{storageAdmissionBytes(t, o), storageAdmissionTime})
	v := url.Values{"kind": {"whole"}, "assetAddress": {storageAdmissionAsset}, "tokenId": {"1"}}
	read := func() int {
		w := httptest.NewRecorder()
		service.getSignedOrders(w, httptest.NewRequest("GET", "/v1/orders?"+v.Encode(), nil))
		return w.Code
	}
	if read() != 200 {
		t.Fatal("valid whole scope rejected")
	}
	v.Set("tokenId", "2")
	if read() != 503 {
		t.Fatal("different whole token admitted")
	}
}
