package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func analyticsScope() nativeAnalyticsScope {
	return nativeAnalyticsScope{performanceMarket, performanceToken, performanceCurrency}
}
func TestNativeAnalyticsExactPricesAndDeterministicBlockOrdering(t *testing.T) {
	events := append(performanceTrade(9007199254740993, true, "3", "9007199254740993", "27021597764222979"), performanceTrade(9007199254740994, false, "2", "7", "14")...)
	result := calculateNativeMarketAnalytics(analyticsScope(), events)
	if result.Status != "observed_indexed_subset" || result.TradeCount != 2 || *result.Quantity != "5" || *result.Payment != "27021597764222993" || result.PriceHistory[0].BlockNumber != "9007199254740993" || result.PriceHistory[0].UnitPrice != "9007199254740993" || result.DistinctParticipants != 2 {
		t.Fatalf("lost exact evidence: %+v", result)
	}
	if result.HolderDistribution != nil || !strings.Contains(result.Coverage, "not_complete") || !strings.Contains(result.Finality, "not_independent") {
		t.Fatal("projection enlarged its authority")
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	if !reflect.DeepEqual(result, calculateNativeMarketAnalytics(analyticsScope(), events)) {
		t.Fatal("read order changed series")
	}
}
func TestNativeAnalyticsDuplicatesNeverIncreaseVolume(t *testing.T) {
	events := performanceTrade(1, true, "5", "3", "15")
	events = append(events, events...)
	result := calculateNativeMarketAnalytics(analyticsScope(), events)
	if result.TradeCount != 1 || *result.Quantity != "5" || *result.Payment != "15" {
		t.Fatal(result)
	}
}
func TestNativeAnalyticsConflictingIdentitySuppressesAllNumbers(t *testing.T) {
	events := performanceTrade(1, true, "5", "3", "15")
	other := events[1]
	other.BlockHash = fmt.Sprintf("0x%064x", 999)
	events = append(events, other)
	result := calculateNativeMarketAnalytics(analyticsScope(), events)
	if result.Status != "conflicting_indexed_evidence" || result.Quantity != nil || result.Payment != nil || len(result.PriceHistory) != 0 || result.TradeCount != 0 {
		t.Fatal(result)
	}
}
func TestNativeAnalyticsPendingAndRemovedNeverBecomeTrades(t *testing.T) {
	pending := performanceTrade(1, true, "5", "3", "15")
	pending[0].Confirmed = false
	pending[1].Confirmed = false
	removed := performanceTrade(2, true, "5", "3", "15")
	removed[0].Removed = true
	removed[1].Removed = true
	result := calculateNativeMarketAnalytics(analyticsScope(), append(pending, removed...))
	if result.TradeCount != 0 || *result.Quantity != "0" || result.PendingFillCount != 1 || result.RemovedFillCount != 1 || result.Status != "incomplete_indexed_subset" {
		t.Fatal(result)
	}
}
func TestNativeAnalyticsUnmatchedAndMalformedFillsRemainExcluded(t *testing.T) {
	for _, change := range []func([]portfolioEvidence){
		func(e []portfolioEvidence) { e[0].Removed = true },
		func(e []portfolioEvidence) { e[1].Payload["payment"] = json.RawMessage(`"14"`) },
		func(e []portfolioEvidence) { e[1].Order = nil },
		func(e []portfolioEvidence) { e[1].BlockHash = "bad" },
		func(e []portfolioEvidence) { e[1].BlockNumber = 0 },
		func(e []portfolioEvidence) { e[0].Payload["value"] = json.RawMessage(`"4"`) },
	} {
		events := performanceTrade(1, true, "5", "3", "15")
		change(events)
		result := calculateNativeMarketAnalytics(analyticsScope(), events)
		if result.TradeCount != 0 || *result.Payment != "0" || result.UnmatchedFillCount != 1 || len(result.PriceHistory) != 0 {
			t.Fatal(result)
		}
	}
}
func TestNativeAnalyticsNeverMixesMarketsAssetsOrPaymentCurrencies(t *testing.T) {
	for _, change := range []func([]portfolioEvidence){
		func(e []portfolioEvidence) { e[1].ContractAddress = performanceToken },
		func(e []portfolioEvidence) {
			e[1].Order.Intent["assetToken"] = json.RawMessage(`"0x1111111111111111111111111111111111111111"`)
		},
		func(e []portfolioEvidence) {
			e[1].Order.Intent["paymentToken"] = json.RawMessage(`"0x1111111111111111111111111111111111111111"`)
		},
	} {
		events := performanceTrade(1, true, "5", "3", "15")
		change(events)
		result := calculateNativeMarketAnalytics(analyticsScope(), events)
		if result.TradeCount != 0 || *result.Payment != "0" || len(result.PriceHistory) != 0 {
			t.Fatal(result)
		}
	}
}
func TestNativeAnalyticsEvidenceCapDoesNotPresentPartialTotals(t *testing.T) {
	result := calculateNativeMarketAnalytics(analyticsScope(), make([]portfolioEvidence, nativeAnalyticsLimit+1))
	if result.Status != "history_limit_exceeded" || result.Quantity != nil || result.Payment != nil || len(result.PriceHistory) != 0 {
		t.Fatal(result)
	}
}
func TestNativeAnalyticsRecentHistoryBoundDoesNotTruncateAcceptedTotals(t *testing.T) {
	events := []portfolioEvidence{}
	for i := 1; i <= 201; i++ {
		events = append(events, performanceTrade(uint64(i), true, "1", "3", "3")...)
	}
	result := calculateNativeMarketAnalytics(analyticsScope(), events)
	if result.TradeCount != 201 || *result.Payment != "603" || !result.PriceHistoryTruncated || len(result.PriceHistory) != 200 || result.PriceHistory[0].BlockNumber != "2" || result.PriceHistory[199].BlockNumber != "201" {
		t.Fatal(result)
	}
}
func TestNativeAnalyticsRemovedFillRecomputationRetainsOnlyCanonicalSubset(t *testing.T) {
	first := performanceTrade(1, true, "5", "3", "15")
	second := performanceTrade(2, true, "7", "4", "28")
	events := append(first, second...)
	before := calculateNativeMarketAnalytics(analyticsScope(), events)
	if before.TradeCount != 2 || *before.Payment != "43" {
		t.Fatal(before)
	}
	events[2].Removed = true
	events[3].Removed = true
	after := calculateNativeMarketAnalytics(analyticsScope(), events)
	if after.TradeCount != 1 || *after.Payment != "15" || after.RemovedFillCount != 1 || len(after.PriceHistory) != 1 {
		t.Fatal(after)
	}
}
func TestNativeAnalyticsRouteScopeAndDatabaseAvailability(t *testing.T) {
	good := "chainId=560048&marketAddress=" + performanceMarket + "&assetToken=" + performanceToken + "&paymentToken=" + performanceCurrency
	cases := []struct {
		query  string
		status int
	}{{good, 503}, {good + "&chainId=560048", 400}, {strings.Replace(good, "560048", "1", 1), 400}, {good + "&source=trusted", 400}, {strings.Replace(good, performanceToken, "0x0000000000000000000000000000000000000000", 1), 400}, {strings.Replace(good, performanceCurrency, performanceToken, 1), 400}, {good + "&bad=%xx", 400}}
	for _, item := range cases {
		request := httptest.NewRequest("GET", "/v1/market/native-analytics", nil)
		request.URL.RawQuery = item.query
		response := httptest.NewRecorder()
		newHandler(&rwaService{}).ServeHTTP(response, request)
		if response.Code != item.status {
			t.Fatalf("%s: %d %s", item.query, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "priceHistory") {
			t.Fatal("failed dependency invented analytics")
		}
	}
}

func TestNativeAnalyticsDecodeByteBudget(t *testing.T) {
	payload, err := json.Marshal(map[string]string{"padding": strings.Repeat("x", 65536-len(`{"padding":""}`))})
	if err != nil || len(payload) != 65536 {
		t.Fatal("test payload boundary")
	}
	used := (4 << 20) - len(payload) - len("null")
	var event portfolioEvidence
	if err := decodeNativeAnalyticsRow(&event, payload, []byte("null"), &used); err != nil || used != 4<<20 {
		t.Fatal("exact byte bound was refused", err, used)
	}
	if err := decodeNativeAnalyticsRow(&event, []byte(`{}`), []byte("null"), &used); err == nil || used != 4<<20 {
		t.Fatal("aggregate byte budget exceeded without refusal")
	}
	for _, item := range []struct{ payload, order []byte }{
		{append(payload, ' '), []byte("null")},
		{[]byte(`{}`), []byte(strings.Repeat(" ", 32769))},
		{[]byte(`null`), []byte("null")},
		{[]byte(`[]`), []byte("null")},
		{[]byte(`{`), []byte("null")},
	} {
		used = 0
		if decodeNativeAnalyticsRow(&event, item.payload, item.order, &used) == nil {
			t.Fatal("oversized or malformed indexed evidence was accepted")
		}
	}
}
