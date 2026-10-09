package httpapi

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestMySQLPortfolioPerformanceNotificationsAndReorg(t *testing.T) {
	configurePortfolioTestAuth(t)
	db, _, _, _ := walletAuthIntegrationFixture(t)
	const key = "portfolio-performance-test-indexer"
	openService := func() (*rwaService, http.Handler) {
		service := newRWAService(rwaConfig{}, newMemoryObjectStore())
		service.db, service.indexerEnabled, service.indexerKeyHash = db, true, sha256.Sum256([]byte(key))
		service.cache = &memoryCache{values: map[string]string{}}
		return service, newHandler(service)
	}
	_, handler := openService()
	events := append(performanceTrade(600001, true, "5", "3", "15"), performanceTrade(600002, false, "2", "4", "8")...)
	cleanup := func() {
		for _, event := range events {
			for _, table := range []string{"portfolio_deltas", "chain_events"} {
				if _, err := db.Exec("DELETE FROM "+table+" WHERE transaction_hash = ?", event.TransactionHash); err != nil {
					t.Error(err)
				}
			}
			if event.Order != nil {
				if _, err := db.Exec("DELETE FROM native_signed_orders WHERE intent_hash = ?", event.Order.IntentHash); err != nil {
					t.Error(err)
				}
			}
		}
		for _, table := range []string{"wallet_user_sessions", "wallet_user_challenges"} {
			db.Exec("DELETE FROM "+table+" WHERE wallet_address = ?", performanceOwner)
		}
	}
	cleanup()
	defer cleanup()
	for _, event := range events {
		if event.Order == nil {
			continue
		}
		raw, _ := json.Marshal(event.Order)
		hash := sha256.Sum256(raw)
		_, err := db.Exec(`INSERT INTO native_signed_orders (chain_id,market_address,intent_hash,kind,seller_address,asset_address,envelope_json,payload_hash) VALUES (?,?,?,?,?,?,?,?)`, hoodiChainID, performanceMarket, event.Order.IntentHash, "fraction", orderString(event.Order.Intent, "seller"), performanceToken, raw, hash[:])
		if err != nil {
			t.Fatal(err)
		}
	}
	ingest := func(event portfolioEvidence, removed bool, confirmations uint32) {
		t.Helper()
		result := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", map[string]any{"chainId": hoodiChainID, "transactionHash": event.TransactionHash, "logIndex": event.LogIndex, "blockNumber": event.BlockNumber, "blockHash": event.BlockHash, "contractAddress": event.ContractAddress, "eventName": event.EventName, "payload": event.Payload, "removed": removed, "confirmations": confirmations}, map[string]string{"X-Indexer-Key": key})
		if result.Code != 200 && result.Code != 201 {
			t.Fatalf("ingest: %d %s", result.Code, result.Body.String())
		}
	}
	read := func() portfolioResponse {
		t.Helper()
		result := authenticatedPortfolioRead(t, handler, db, performanceOwner)
		if result.Code != 200 {
			t.Fatalf("read: %d %s", result.Code, result.Body.String())
		}
		var portfolio portfolioResponse
		decode(t, result, &portfolio)
		return portfolio
	}
	for _, event := range events {
		ingest(event, false, 1)
	}
	first := read()
	assertKnownPerformance(t, first.Performance, "3", "9", "2")
	if len(first.Transactions) != 4 || len(first.Notifications) != 4 {
		t.Fatalf("buyer/seller events omitted: %+v", first)
	}
	// Replaying all evidence must not change balances or multiply notifications.
	for _, event := range events {
		ingest(event, false, 1)
	}
	replay := read()
	assertKnownPerformance(t, replay.Performance, "3", "9", "2")
	if len(replay.Notifications) != 4 || replay.Positions[0].Balance != "3" {
		t.Fatal("replay double counted evidence")
	}
	// Removed sale evidence invalidates cached results and updates the same IDs.
	for _, event := range events[2:] {
		ingest(event, true, 1)
	}
	removed := read()
	assertKnownPerformance(t, removed.Performance, "5", "15", "0")
	count := 0
	for _, notice := range removed.Notifications {
		if notice.Status == "removed" {
			count++
			if !strings.Contains(notice.Message, "no longer applies") {
				t.Fatal(notice)
			}
		}
	}
	if count != 2 || len(removed.Notifications) != 4 {
		t.Fatal("removed notifications missing or duplicated")
	}
	_, handler = openService()
	assertKnownPerformance(t, read().Performance, "5", "15", "0")
	for _, event := range events[2:] {
		ingest(event, false, 1)
	}
	assertKnownPerformance(t, read().Performance, "3", "9", "2")
	// A fresh bidder-only event is visible without a Transfer and invalidates cache.
	bid := portfolioEvidence{TransactionHash: events[0].TransactionHash, LogIndex: 99, BlockNumber: 600001, BlockHash: events[0].BlockHash, ContractAddress: performanceMarket, EventName: "BidPlaced", Payload: performancePayload(map[string]string{"bidder": performanceOwner, "listingId": "5", "amount": "12"})}
	ingest(bid, false, 0)
	pending := read()
	if len(pending.Notifications) != 5 || pending.Notifications[0].EventName != "BidPlaced" || pending.Notifications[0].Status != "pending" {
		t.Fatalf("bidder pending notification missing: %+v", pending.Notifications)
	}
	id := pending.Notifications[0].ID
	ingest(bid, false, 3)
	confirmed := read()
	if confirmed.Notifications[0].ID != id || confirmed.Notifications[0].Status != "confirmed" {
		t.Fatal("confirmation did not update existing notice")
	}
	ingest(bid, true, 3)
	if notice := read().Notifications[0]; notice.ID != id || notice.Status != "removed" {
		t.Fatal("removed notice not exposed")
	}
}
