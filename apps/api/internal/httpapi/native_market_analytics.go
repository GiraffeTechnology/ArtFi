package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

const nativeAnalyticsLimit = 20000
const nativePriceHistoryLimit = 200

type nativeAnalyticsScope struct{ market, asset, payment string }
type nativePriceObservation struct {
	TransactionHash string `json:"transactionHash"`
	BlockHash       string `json:"blockHash"`
	BlockNumber     string `json:"blockNumber"`
	LogIndex        uint32 `json:"logIndex"`
	UnitPrice       string `json:"unitPrice"`
	Quantity        string `json:"quantity"`
	Payment         string `json:"payment"`
}
type nativeMarketAnalytics struct {
	SchemaVersion         int                      `json:"schemaVersion"`
	ChainID               int                      `json:"chainId"`
	MarketAddress         string                   `json:"marketAddress"`
	AssetToken            string                   `json:"assetToken"`
	PaymentToken          string                   `json:"paymentToken"`
	Status                string                   `json:"status"`
	Scope                 string                   `json:"scope"`
	Coverage              string                   `json:"coverage"`
	Finality              string                   `json:"finality"`
	TradeCount            int                      `json:"tradeCount"`
	Quantity              *string                  `json:"quantity"`
	Payment               *string                  `json:"payment"`
	DistinctParticipants  int                      `json:"distinctParticipants"`
	PendingFillCount      int                      `json:"pendingFillCount"`
	RemovedFillCount      int                      `json:"removedFillCount"`
	UnmatchedFillCount    int                      `json:"unmatchedFillCount"`
	PriceHistory          []nativePriceObservation `json:"priceHistory"`
	PriceHistoryTruncated bool                     `json:"priceHistoryTruncated"`
	HolderDistribution    any                      `json:"holderDistribution"`
	Reasons               []string                 `json:"reasons"`
}

func newNativeAnalytics(scope nativeAnalyticsScope) nativeMarketAnalytics {
	return nativeMarketAnalytics{SchemaVersion: 1, ChainID: hoodiChainID, MarketAddress: scope.market, AssetToken: scope.asset, PaymentToken: scope.payment, Status: "no_matched_fills", Scope: "indexed_native_fraction_fills", Coverage: "bounded_indexed_projection_not_complete_chain_history", Finality: "indexer_confirmed_not_independent_chain_finality", PriceHistory: []nativePriceObservation{}, Reasons: []string{"Amounts and unit prices are exact token base units; no decimal or fiat conversion is implied.", "Price observations are ordered by block and log index. Indexer observation time is not a block timestamp.", "Participant counts describe accepted trades, not all token holders. Complete holder distribution is unavailable."}}
}

// This is an attributed read projection, never a price oracle or trading authority.
// Rebuild every response from the same database snapshot, excluding removed logs.
func calculateNativeMarketAnalytics(scope nativeAnalyticsScope, input []portfolioEvidence) nativeMarketAnalytics {
	result := newNativeAnalytics(scope)
	if len(input) > nativeAnalyticsLimit {
		result.Status = "history_limit_exceeded"
		result.Reasons = append(result.Reasons, "The indexed evidence limit was exceeded; no partial totals or prices are presented.")
		return result
	}
	unique := map[string]portfolioEvidence{}
	for _, event := range input {
		id := strings.ToLower(event.TransactionHash) + ":" + strconv.FormatUint(uint64(event.LogIndex), 10)
		if prior, exists := unique[id]; exists {
			if !reflect.DeepEqual(prior, event) {
				result.Status = "conflicting_indexed_evidence"
				result.Reasons = append(result.Reasons, "A transaction/log identity has conflicting indexed evidence; totals and prices are unavailable.")
				return result
			}
			continue
		}
		unique[id] = event
	}
	events := make([]portfolioEvidence, 0, len(unique))
	for _, event := range unique {
		events = append(events, event)
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i].BlockNumber != events[j].BlockNumber {
			return events[i].BlockNumber < events[j].BlockNumber
		}
		if events[i].LogIndex != events[j].LogIndex {
			return events[i].LogIndex < events[j].LogIndex
		}
		return events[i].TransactionHash < events[j].TransactionHash
	})
	fills, transfers := map[string]*big.Int{}, map[string]*big.Int{}
	add := func(target map[string]*big.Int, key string, amount *big.Int) {
		if target[key] == nil {
			target[key] = new(big.Int)
		}
		target[key].Add(target[key], amount)
	}
	eligible := func(event portfolioEvidence) (performanceFill, bool) {
		if event.EventName != "IntentFilled" || !strings.EqualFold(event.ContractAddress, scope.market) {
			return performanceFill{}, false
		}
		fill, ok := mappedPerformanceFill(event)
		return fill, ok && fill.asset == scope.asset && fill.currency == scope.payment
	}
	for _, event := range events {
		if event.Removed || !event.Confirmed || !txHashPattern.MatchString(event.TransactionHash) || !txHashPattern.MatchString(event.BlockHash) || event.BlockNumber == 0 {
			continue
		}
		// Asset transfers carry no payment currency. Reconcile the complete asset
		// flow for this market, then keep the requested currency in reported totals.
		if event.EventName == "IntentFilled" && strings.EqualFold(event.ContractAddress, scope.market) {
			if fill, ok := mappedPerformanceFill(event); ok && fill.asset == scope.asset {
				add(fills, fill.key, fill.amount)
			}
		}
		if event.EventName == "Transfer" && strings.EqualFold(event.ContractAddress, scope.asset) {
			if amount, ok := positiveEvidenceInteger(evidenceString(event, "value")); ok {
				add(transfers, transferMatchKey(event, scope.asset, evidenceString(event, "from"), evidenceString(event, "to")), amount)
			}
		}
	}
	totalQuantity, totalPayment := new(big.Int), new(big.Int)
	participants := map[string]bool{}
	for _, event := range events {
		if event.EventName != "IntentFilled" || !strings.EqualFold(event.ContractAddress, scope.market) {
			continue
		}
		// A stored order for another asset/currency is outside this requested series.
		if event.Order != nil && event.Order.Kind == "fraction" && (strings.ToLower(orderString(event.Order.Intent, "assetToken")) != scope.asset || strings.ToLower(orderString(event.Order.Intent, "paymentToken")) != scope.payment) {
			continue
		}
		if event.Removed {
			result.RemovedFillCount++
			continue
		}
		if !event.Confirmed {
			result.PendingFillCount++
			continue
		}
		fill, ok := eligible(event)
		if !ok || !txHashPattern.MatchString(event.TransactionHash) || !txHashPattern.MatchString(event.BlockHash) || event.BlockNumber == 0 || fills[fill.key] == nil || transfers[fill.key] == nil || fills[fill.key].Cmp(transfers[fill.key]) != 0 {
			result.UnmatchedFillCount++
			continue
		}
		result.TradeCount++
		totalQuantity.Add(totalQuantity, fill.amount)
		totalPayment.Add(totalPayment, fill.payment)
		participants[fill.seller] = true
		participants[fill.buyer] = true
		result.PriceHistory = append(result.PriceHistory, nativePriceObservation{TransactionHash: event.TransactionHash, BlockHash: event.BlockHash, BlockNumber: strconv.FormatUint(event.BlockNumber, 10), LogIndex: event.LogIndex, UnitPrice: fill.unitCost.String(), Quantity: fill.amount.String(), Payment: fill.payment.String()})
	}
	quantity, payment := totalQuantity.String(), totalPayment.String()
	result.Quantity = &quantity
	result.Payment = &payment
	result.DistinctParticipants = len(participants)
	if result.TradeCount > 0 {
		result.Status = "observed_indexed_subset"
	}
	if result.PendingFillCount > 0 || result.UnmatchedFillCount > 0 {
		result.Status = "incomplete_indexed_subset"
		result.Reasons = append(result.Reasons, "Pending or unmatched fills were excluded. Totals cover accepted matching records only and are not complete market volume.")
	}
	if len(result.PriceHistory) > nativePriceHistoryLimit {
		result.PriceHistoryTruncated = true
		result.PriceHistory = result.PriceHistory[len(result.PriceHistory)-nativePriceHistoryLimit:]
	}
	return result
}

func nativeAnalyticsQuery(request *http.Request) (nativeAnalyticsScope, bool) {
	q, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return nativeAnalyticsScope{}, false
	}
	if len(q) != 4 {
		return nativeAnalyticsScope{}, false
	}
	for _, key := range []string{"chainId", "marketAddress", "assetToken", "paymentToken"} {
		if len(q[key]) != 1 {
			return nativeAnalyticsScope{}, false
		}
	}
	if q.Get("chainId") != "560048" {
		return nativeAnalyticsScope{}, false
	}
	scope := nativeAnalyticsScope{strings.ToLower(q.Get("marketAddress")), strings.ToLower(q.Get("assetToken")), strings.ToLower(q.Get("paymentToken"))}
	for _, value := range []string{scope.market, scope.asset, scope.payment} {
		if !addressPattern.MatchString(value) || value == "0x0000000000000000000000000000000000000000" {
			return nativeAnalyticsScope{}, false
		}
	}
	return scope, scope.asset != scope.payment
}

func decodeNativeAnalyticsRow(event *portfolioEvidence, payload, order []byte, used *int) error {
	if len(payload) > 65536 || len(order) > 32768 || *used > (4<<20)-len(payload)-len(order) {
		return errors.New("native analytics evidence byte budget exceeded")
	}
	*used += len(payload) + len(order)
	if err := json.Unmarshal(payload, &event.Payload); err != nil {
		return err
	}
	if event.Payload == nil {
		return errors.New("native analytics event payload is not an object")
	}
	return json.Unmarshal(order, &event.Order)
}

func (service *rwaService) getNativeMarketAnalytics(writer http.ResponseWriter, request *http.Request) {
	scope, ok := nativeAnalyticsQuery(request)
	if !ok {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid analytics scope", "Supply exactly one supported chainId, marketAddress, assetToken and paymentToken.")
		return
	}
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Analytics unavailable", "The indexed market database is unavailable; no sample analytics are substituted.")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Analytics unavailable", "The indexed evidence snapshot could not be read.")
		return
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT LOWER(e.transaction_hash), e.log_index, e.block_number,
 LOWER(e.block_hash), LOWER(e.contract_address), e.event_name, e.confirmed, e.removed,
 LEFT(e.payload, 65537), LEFT(COALESCE(o.envelope_json, 'null'), 32769)
 FROM chain_events e LEFT JOIN native_signed_orders o
 ON e.event_name = 'IntentFilled' AND o.chain_id = e.chain_id
 AND o.market_address = LOWER(e.contract_address)
 AND o.intent_hash = LOWER(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.intentHash')))
 WHERE e.chain_id = ? AND ((e.event_name = 'IntentFilled' AND LOWER(e.contract_address) = ?)
 OR (e.event_name = 'Transfer' AND LOWER(e.contract_address) = ?))
 ORDER BY e.block_number, e.log_index, e.transaction_hash LIMIT ?`, hoodiChainID, scope.market, scope.asset, nativeAnalyticsLimit+1)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Analytics unavailable", "The indexed evidence snapshot could not be read.")
		return
	}
	events := []portfolioEvidence{}
	evidenceBytes := 0
	for rows.Next() {
		var event portfolioEvidence
		var payload, order []byte
		if err = rows.Scan(&event.TransactionHash, &event.LogIndex, &event.BlockNumber, &event.BlockHash, &event.ContractAddress, &event.EventName, &event.Confirmed, &event.Removed, &payload, &order); err != nil {
			break
		}
		if err = decodeNativeAnalyticsRow(&event, payload, order, &evidenceBytes); err != nil {
			break
		}
		events = append(events, event)
	}
	if err == nil {
		err = rows.Err()
	}
	closeErr := rows.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Analytics unavailable", "The indexed evidence snapshot could not be read completely.")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, calculateNativeMarketAnalytics(scope, events))
}
