package httpapi

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	performanceOwner        = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	performanceCounterparty = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	performanceToken        = "0xcccccccccccccccccccccccccccccccccccccccc"
	performanceCurrency     = "0xdddddddddddddddddddddddddddddddddddddddd"
	performanceMarket       = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
)

func performancePayload(fields map[string]string) map[string]json.RawMessage {
	result := map[string]json.RawMessage{}
	for key, value := range fields {
		result[key], _ = json.Marshal(value)
	}
	return result
}
func performanceTrade(block uint64, buy bool, amount, price, payment string) []portfolioEvidence {
	seller, buyer := performanceCounterparty, performanceOwner
	if !buy {
		seller, buyer = buyer, seller
	}
	hash := fmt.Sprintf("0x%064x", block)
	intentHash := fmt.Sprintf("0x%064x", block+100)
	transfer := portfolioEvidence{TransactionHash: hash, LogIndex: 1, BlockNumber: block, BlockHash: fmt.Sprintf("0x%064x", block+1000), ContractAddress: performanceToken, EventName: "Transfer", Confirmed: true, Payload: performancePayload(map[string]string{"from": seller, "to": buyer, "value": amount, "symbol": "FRC"})}
	fill := transfer
	fill.LogIndex, fill.EventName, fill.ContractAddress = 2, "IntentFilled", performanceMarket
	fill.Payload = performancePayload(map[string]string{"intentHash": intentHash, "seller": seller, "buyer": buyer, "amount": amount, "payment": payment})
	fill.Order = &signedOrder{Kind: "fraction", ChainID: hoodiChainID, MarketAddress: performanceMarket, IntentHash: intentHash, Intent: performancePayload(map[string]string{"seller": seller, "assetToken": performanceToken, "paymentToken": performanceCurrency, "unitPrice": price})}
	return []portfolioEvidence{transfer, fill}
}
func onlyPerformanceItem(t *testing.T, result portfolioPerformance) portfolioPerformanceItem {
	t.Helper()
	if len(result.Items) != 1 {
		t.Fatalf("expected one item: %+v", result)
	}
	return result.Items[0]
}
func assertKnownPerformance(t *testing.T, result portfolioPerformance, quantity, cost, realized string) {
	t.Helper()
	item := onlyPerformanceItem(t, result)
	if item.Status != "known" || item.ConfirmedQuantity == nil || *item.ConfirmedQuantity != quantity || item.CostBasis == nil || *item.CostBasis != cost || item.RealizedPnL == nil || *item.RealizedPnL != realized {
		t.Fatalf("unexpected performance: %+v", item)
	}
}
func assertUnknownPerformance(t *testing.T, result portfolioPerformance, reason string) {
	t.Helper()
	item := onlyPerformanceItem(t, result)
	if item.Status != "unknown" || item.CostBasis != nil || item.RealizedPnL != nil || !strings.Contains(strings.Join(item.Reasons, " "), reason) {
		t.Fatalf("unknown basis rendered as numeric P&L: %+v", item)
	}
}
func TestPortfolioFIFOExactPartialSalesAndNegativePnL(t *testing.T) {
	events := append(performanceTrade(1, true, "5", "3", "15"), performanceTrade(2, true, "5", "7", "35")...)
	events = append(events, performanceTrade(3, false, "7", "4", "28")...)
	result := calculatePortfolioPerformance(performanceOwner, events)
	assertKnownPerformance(t, result, "3", "21", "-1")
	if result.Method != "fifo" || result.Status != "known_for_indexed_history" {
		t.Fatal(result)
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	if other := calculatePortfolioPerformance(performanceOwner, events); !reflect.DeepEqual(result, other) {
		t.Fatal("projection depends on read order")
	}
}
func TestPortfolioNeverConvertsLargeTokenAmountsToFloat(t *testing.T) {
	events := performanceTrade(1, true, "900719925474099300000000000001", "2", "1801439850948198600000000000002")
	events = append(events, performanceTrade(2, false, "1", "3", "3")...)
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "900719925474099300000000000000", "1801439850948198600000000000000", "1")
}
func TestPortfolioUnknownBasisNeverBecomesFalseZero(t *testing.T) {
	t.Run("unmatched gift", func(t *testing.T) {
		events := append(performanceTrade(1, true, "5", "3", "15"), performanceTrade(2, true, "1", "1", "1")[0])
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "no matching")
	})
	t.Run("unmatched outbound", func(t *testing.T) {
		events := append(performanceTrade(1, true, "5", "3", "15"), performanceTrade(2, false, "1", "1", "1")[0])
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "no matching")
	})
	t.Run("opening quantity missing", func(t *testing.T) {
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, performanceTrade(1, false, "5", "3", "15")), "opening cost basis")
	})
	t.Run("currency change", func(t *testing.T) {
		events := performanceTrade(1, true, "5", "3", "15")
		sale := performanceTrade(2, false, "1", "4", "4")
		sale[1].Order.Intent["paymentToken"], _ = json.Marshal(performanceMarket)
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, append(events, sale...)), "currency changed")
	})
	t.Run("transfer missing", func(t *testing.T) {
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, performanceTrade(1, true, "5", "3", "15")[1:]), "does not reconcile")
	})
	t.Run("wrong payment amount", func(t *testing.T) {
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, performanceTrade(1, true, "5", "3", "16")), "cannot be verified")
	})
	t.Run("wrong block transfer", func(t *testing.T) {
		events := performanceTrade(1, true, "5", "3", "15")
		events[0].BlockHash = "0x" + strings.Repeat("9", 64)
		assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "does not reconcile")
	})
	t.Run("pending transfer", func(t *testing.T) {
		events := performanceTrade(1, true, "5", "3", "15")
		events[0].Confirmed = false
		result := calculatePortfolioPerformance(performanceOwner, events)
		assertUnknownPerformance(t, result, "Pending transfer")
		if result.PendingEventCount != 1 {
			t.Fatal(result)
		}
	})
	t.Run("unsupported whole or missing order", func(t *testing.T) {
		for _, kind := range []string{"whole", "missing"} {
			events := performanceTrade(1, true, "5", "3", "15")
			if kind == "whole" {
				events[1].Order.Kind = "whole"
			} else {
				events[1].Order = nil
			}
			result := calculatePortfolioPerformance(performanceOwner, events)
			assertUnknownPerformance(t, result, "no matching")
			if result.UnmappedTradeCount != 1 {
				t.Fatal(result)
			}
		}
	})
}
func TestPortfolioReorgRebuildRemovesAndRestoresBasis(t *testing.T) {
	events := append(performanceTrade(1, true, "5", "3", "15"), performanceTrade(2, false, "2", "4", "8")...)
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "3", "9", "2")
	for i := 2; i < 4; i++ {
		events[i].Removed = true
	}
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "5", "15", "0")
	for i := 2; i < 4; i++ {
		events[i].Removed = false
	}
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "3", "9", "2")
	for i := 0; i < 2; i++ {
		events[i].Removed = true
	}
	assertUnknownPerformance(t, calculatePortfolioPerformance(performanceOwner, events), "opening cost basis")
}
func TestPortfolioAggregatesMultipleFillsPerTransferWithoutDoubleCounting(t *testing.T) {
	events := performanceTrade(1, true, "5", "3", "15")
	extra := performanceTrade(1, true, "2", "3", "6")[1]
	extra.LogIndex = 3
	events[1].Payload["amount"], _ = json.Marshal("3")
	events[1].Payload["payment"], _ = json.Marshal("9")
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, append(events, extra)), "5", "15", "0")
}
func TestPortfolioZeroAndSelfTransfersDoNotInventBasis(t *testing.T) {
	events := performanceTrade(1, true, "5", "3", "15")
	self := performanceTrade(2, true, "1", "1", "1")[0]
	self.Payload["from"], _ = json.Marshal(performanceOwner)
	zero := performanceTrade(3, true, "0", "1", "0")[0]
	assertKnownPerformance(t, calculatePortfolioPerformance(performanceOwner, append(events, self, zero)), "5", "15", "0")
	empty := calculatePortfolioPerformance(performanceOwner, nil)
	if empty.Status != "no_indexed_history" || len(empty.Items) != 0 {
		t.Fatal(empty)
	}
}
func TestPortfolioNotificationsPreserveIdentityAcrossStatusChanges(t *testing.T) {
	entry := portfolioEntry{ID: portfolioEventID(hoodiChainID, "0x"+strings.Repeat("1", 64), 3), EventName: "IntentFilled", Status: "pending"}
	pending := portfolioEventNotification(entry)
	entry.Status = "confirmed"
	confirmed := portfolioEventNotification(entry)
	entry.Status = "removed"
	removed := portfolioEventNotification(entry)
	if pending.ID != confirmed.ID || pending.ID != removed.ID || !strings.Contains(pending.Message, "pending") || !strings.Contains(removed.Message, "no longer applies") {
		t.Fatal("notification reorg identity/status incorrect")
	}
}

func TestPortfolioPerformanceEvidenceByteBoundaries(t *testing.T) {
	payload := []byte(`{"padding":"` + strings.Repeat("x", portfolioPayloadByteLimit-len(`{"padding":""}`)) + `"}`)
	order := []byte(`{"kind":"` + strings.Repeat("y", portfolioOrderByteLimit-len(`{"kind":""}`)) + `"}`)
	used := portfolioEvidenceByteLimit - len(payload) - len(order)
	var event portfolioEvidence
	if err := decodePortfolioPerformanceRow(&event, payload, order, &used); err != nil || used != portfolioEvidenceByteLimit {
		t.Fatal("exact event, order and aggregate limits must be accepted", err, used)
	}
	original := event
	if err := decodePortfolioPerformanceRow(&event, []byte(`{}`), []byte("null"), &used); err == nil || used != portfolioEvidenceByteLimit || !reflect.DeepEqual(event, original) {
		t.Fatal("aggregate overflow mutated accepted evidence", err, used)
	}
	for _, row := range []struct {
		name           string
		payload, order []byte
	}{
		{"event cap plus one", append(append([]byte{}, payload...), ' '), []byte("null")},
		{"order cap plus one", []byte(`{}`), append(append([]byte{}, order...), ' ')},
		{"null payload", []byte("null"), []byte("null")},
		{"array payload", []byte("[]"), []byte("null")},
		{"malformed payload", []byte("{"), []byte("null")},
		{"malformed order", []byte(`{}`), []byte("{")},
		{"array order", []byte(`{}`), []byte("[]")},
	} {
		t.Run(row.name, func(t *testing.T) {
			used := 0
			event := original
			if err := decodePortfolioPerformanceRow(&event, row.payload, row.order, &used); err == nil || used != 0 || !reflect.DeepEqual(event, original) {
				t.Fatal("rejected row changed evidence or consumed the budget", err, used)
			}
		})
	}
}
func TestPortfolioPerformanceEvidenceCountsUTF8Bytes(t *testing.T) {
	payload := []byte(`{"padding":"` + strings.Repeat("界", 21841) + `"}`)
	if len(payload) != portfolioPayloadByteLimit+1 {
		t.Fatal("invalid UTF-8 boundary fixture", len(payload))
	}
	used := 0
	var event portfolioEvidence
	if err := decodePortfolioPerformanceRow(&event, payload, []byte("null"), &used); err == nil || used != 0 {
		t.Fatal("character count bypassed the byte limit", err, used)
	}
	payload = []byte(`{"padding":"` + strings.Repeat("界", 21840) + `"}`)
	if err := decodePortfolioPerformanceRow(&event, payload, []byte("null"), &used); err != nil || used != len(payload)+4 {
		t.Fatal("valid multibyte evidence was rejected", err, used)
	}
}

// This SQL driver is a row-boundary fixture, not a MySQL or chain acceptance test.
type performanceBoundsDriver struct {
	rows    *performanceBoundsRows
	queries *[]string
}
type performanceBoundsConn struct{ state performanceBoundsDriver }

func (d performanceBoundsDriver) Open(string) (driver.Conn, error) {
	return &performanceBoundsConn{state: d}, nil
}
func (c *performanceBoundsConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *performanceBoundsConn) Close() error                        { return nil }
func (c *performanceBoundsConn) Begin() (driver.Tx, error) {
	return &snapshotDeadlineTx{state: &snapshotDeadlineDBState{}}, nil
}
func (c *performanceBoundsConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return c.Begin()
}
func (c *performanceBoundsConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	*c.state.queries = append(*c.state.queries, query)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.Contains(query, "LEFT(CAST(e.payload AS BINARY), 65537)") {
		if !strings.Contains(query, "LEFT(CAST(COALESCE(o.envelope_json, 'null') AS BINARY), 32769)") ||
			!strings.Contains(query, "ORDER BY e.block_number, e.log_index, e.transaction_hash LIMIT ?") ||
			len(args) < 2 || args[0].Value != int64(hoodiChainID) || args[len(args)-1].Value != int64(portfolioEvidenceLimit+1) {
			return nil, errors.New("SQL bounds, scope or ordering changed")
		}
		return c.state.rows, nil
	}
	if strings.Contains(query, "FROM portfolio_deltas") {
		return &performanceBoundsRows{columns: []string{"asset_token", "symbol", "direction", "amount", "observed_at"}}, nil
	}
	if strings.Contains(query, "FROM chain_events") {
		return &performanceBoundsRows{columns: []string{"transaction_hash", "log_index", "contract_address", "event_name", "block_number", "status", "observed_at"}}, nil
	}
	return nil, errors.New("unexpected query")
}

type performanceBoundsRows struct {
	values   [][]driver.Value
	index    int
	closed   bool
	columns  []string
	endError error
}

func (r *performanceBoundsRows) Columns() []string {
	if r.columns != nil {
		return r.columns
	}
	return []string{"transaction_hash", "log_index", "block_number", "block_hash", "contract_address", "event_name", "confirmed", "removed", "payload", "order"}
}
func (r *performanceBoundsRows) Close() error { r.closed = true; return nil }
func (r *performanceBoundsRows) Next(dest []driver.Value) error {
	if r.index == len(r.values) {
		if r.endError != nil {
			return r.endError
		}
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

var performanceBoundsDBSequence atomic.Uint64

func openPerformanceBoundsDB(t *testing.T, rows *performanceBoundsRows) (*sql.DB, *[]string) {
	t.Helper()
	queries := []string{}
	name := fmt.Sprintf("portfolio-performance-bounds-%d", performanceBoundsDBSequence.Add(1))
	sql.Register(name, performanceBoundsDriver{rows: rows, queries: &queries})
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, &queries
}
func performanceBoundsValues(t *testing.T, events []portfolioEvidence) [][]driver.Value {
	t.Helper()
	result := [][]driver.Value{}
	for _, e := range events {
		payload, err := json.Marshal(e.Payload)
		if err != nil {
			t.Fatal(err)
		}
		order, err := json.Marshal(e.Order)
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, []driver.Value{e.TransactionHash, int64(e.LogIndex), int64(e.BlockNumber), e.BlockHash, e.ContractAddress, e.EventName, e.Confirmed, e.Removed, payload, order})
	}
	return result
}
func TestPortfolioPerformanceBoundedSQLPreservesExactFIFO(t *testing.T) {
	rows := &performanceBoundsRows{values: performanceBoundsValues(t, performanceTrade(1, true, "5", "3", "15"))}
	db, queries := openPerformanceBoundsDB(t, rows)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	got, err := readPortfolioPerformance(context.Background(), tx, performanceOwner)
	if err != nil {
		t.Fatal(err)
	}
	assertKnownPerformance(t, got, "5", "15", "0")
	if !rows.closed || len(*queries) != 1 {
		t.Fatal("rows not closed or unexpected queries")
	}
}
func TestPortfolioPerformanceLateReadFailureReturnsNoPartialTotals(t *testing.T) {
	for _, failure := range []string{"oversized payload", "oversized order", "malformed order", "aggregate limit", "row error"} {
		t.Run(failure, func(t *testing.T) {
			values := performanceBoundsValues(t, performanceTrade(1, true, "5", "3", "15"))
			late := append([]driver.Value{}, values[0]...)
			switch failure {
			case "oversized payload":
				late[8] = []byte(strings.Repeat(" ", portfolioPayloadByteLimit+1))
			case "oversized order":
				late[9] = []byte(strings.Repeat(" ", portfolioOrderByteLimit+1))
			case "malformed order":
				late[9] = []byte("{")
			case "aggregate limit":
				late[8] = []byte(`{"padding":"` + strings.Repeat("x", portfolioPayloadByteLimit-len(`{"padding":""}`)) + `"}`)
				for i := 0; i < 65; i++ {
					values = append(values, late)
				}
			}
			if failure != "aggregate limit" && failure != "row error" {
				values = append(values, late)
			}
			rows := &performanceBoundsRows{values: values}
			if failure == "row error" {
				rows.endError = errors.New("injected evidence read failure")
			}
			db, _ := openPerformanceBoundsDB(t, rows)
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			result, err := readPortfolioPerformance(context.Background(), tx, performanceOwner)
			if err == nil || !reflect.DeepEqual(result, portfolioPerformance{}) || !rows.closed {
				t.Fatal("late failure exposed partial performance or leaked rows", result, err, rows.closed)
			}
		})
	}
}
func TestPortfolioPerformanceOversizedEvidenceIsSanitizedAtHTTPBoundary(t *testing.T) {
	values := performanceBoundsValues(t, performanceTrade(1, true, "5", "3", "15"))
	values[1][9] = []byte(strings.Repeat(" ", portfolioOrderByteLimit+1))
	rows := &performanceBoundsRows{values: values}
	db, queries := openPerformanceBoundsDB(t, rows)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/portfolio/"+performanceOwner, nil)
	newHandler(service).ServeHTTP(recorder, request)
	body := recorder.Body.String()
	if recorder.Code != http.StatusServiceUnavailable || strings.Contains(body, "costBasis") || strings.Contains(body, "realizedPnl") ||
		strings.Contains(body, "byte budget") || !strings.Contains(body, "performance evidence could not be queried") || !rows.closed || len(*queries) != 4 {
		t.Fatal("HTTP failure leaked a partial result, decoder detail or rows", recorder.Code, body, len(*queries), rows.closed)
	}
}
