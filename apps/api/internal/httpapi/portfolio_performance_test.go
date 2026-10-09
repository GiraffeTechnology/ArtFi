package httpapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
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
