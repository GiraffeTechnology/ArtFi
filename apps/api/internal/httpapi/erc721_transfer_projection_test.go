package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestERC721TransferNeverRequiresFungibleProjection(t *testing.T) {
	const zero = "0x0000000000000000000000000000000000000000"
	const alice = "0x7171717171717171717171717171717171717171"
	const bob = "0x7272727272727272727272727272727272727272"
	for _, edge := range []struct{ from, to, id string }{
		{zero, alice, "1"},
		{alice, bob, "0"},
		{alice, zero, "115792089237316195423570985008687907853269984665640564039457584007913129639935"},
		{alice, alice, "42"},
	} {
		payload := map[string]any{"from": edge.from, "to": edge.to, "tokenId": edge.id}
		// A nil SQL transaction makes any accidental fungible database call fail.
		// This executes the actual projection entry, not just the classifier.
		if err := projectTransfer(httptest.NewRequest("POST", "/v1/indexer/events", nil), nil,
			chainEventRequest{EventName: "Transfer", Payload: payload}); err != nil {
			t.Fatalf("valid NFT transfer reached the fungible projection: %v", err)
		}
	}
}

func TestERC721TransferRejectsMalformedOrAmbiguousIdentity(t *testing.T) {
	const owner = "0x7171717171717171717171717171717171717171"
	for _, bad := range []any{
		nil, 1, 1.0, "", "01", "+1", "-1", "1.0", "0x01", " 1", "1\n",
		"115792089237316195423570985008687907853269984665640564039457584007913129639936",
		strings.Repeat("9", 79),
	} {
		payload := map[string]any{"from": owner, "to": owner, "tokenId": bad}
		if _, err := isERC721TransferPayload(payload); !errors.Is(err, errEventConflict) {
			t.Fatalf("accepted malformed token ID %#v", bad)
		}
	}
	for _, payload := range []map[string]any{
		{"from": owner, "to": owner, "tokenId": "1", "value": "1"},
		{"from": owner, "to": owner, "tokenId": "1", "symbol": "NFT"},
		{"from": owner, "to": owner, "tokenId": "1", "unknown": true},
		{"from": owner, "tokenId": "1"},
		{"from": "0x01", "to": owner, "tokenId": "1"},
		{"from": owner, "to": nil, "tokenId": "1"},
		{"from": "0x0000000000000000000000000000000000000000", "to": "0x0000000000000000000000000000000000000000", "tokenId": "1"},
	} {
		if _, err := isERC721TransferPayload(payload); !errors.Is(err, errEventConflict) {
			t.Fatalf("accepted ambiguous or incomplete NFT transfer: %#v", payload)
		}
	}
}

func TestLegacyFungibleAndUnrelatedEventsRetainTheirProjectionPath(t *testing.T) {
	for _, payload := range []map[string]any{
		nil,
		{"from": "invalid", "to": "invalid", "value": "1", "symbol": "FRC"},
		{"from": "0x7171717171717171717171717171717171717171", "to": "0x7272727272727272727272727272727272727272", "value": "1", "symbol": "FRC"},
	} {
		if nft, err := isERC721TransferPayload(payload); nft || err != nil {
			t.Fatalf("legacy payload was reclassified or bypassed existing validation: %t %v", nft, err)
		}
	}
	if err := projectTransfer(httptest.NewRequest("POST", "/v1/indexer/events", nil), nil,
		chainEventRequest{EventName: "TestNFTMinted", Payload: map[string]any{"tokenId": nil}}); err != nil {
		t.Fatalf("unrelated event gained transfer projection semantics: %v", err)
	}
}

func TestMySQLERC721TransferReplayKeepsEventsWithoutFungibleBalances(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set; real MySQL NFT replay is unverified")
	}
	const owner = "0x7171717171717171717171717171717171717171"
	const collection = "0x7272727272727272727272727272727272727272"
	const indexerKey = "erc721-transfer-replay-test-key"
	identity := sha256.Sum256([]byte(t.Name() + time.Now().UTC().Format(time.RFC3339Nano)))
	transactionHash := "0x" + hex.EncodeToString(identity[:])
	const logIndex = 3
	openService := func() (*sql.DB, http.Handler) {
		t.Helper()
		db, err := sql.Open("mysql", dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { db.Close() })
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			t.Fatalf("NFT replay MySQL unavailable: %v", err)
		}
		service := newRWAService(rwaConfig{}, newMemoryObjectStore())
		service.db = db
		service.indexerKeyHash = sha256.Sum256([]byte(indexerKey))
		service.indexerEnabled = true
		return db, newHandler(service)
	}
	db, handler := openService()
	t.Cleanup(func() {
		// Only this invocation's synthetic identity is eligible for cleanup.
		cleanupDB, err := sql.Open("mysql", dsn)
		if err != nil {
			t.Errorf("open NFT replay cleanup: %v", err)
			return
		}
		defer cleanupDB.Close()
		for _, table := range []string{"portfolio_deltas", "chain_events"} {
			if _, err := cleanupDB.Exec("DELETE FROM "+table+" WHERE chain_id = ? AND transaction_hash = ? AND log_index = ?", hoodiChainID, transactionHash, logIndex); err != nil {
				t.Errorf("clean up NFT replay %s: %v", table, err)
			}
		}
	})
	body := map[string]any{
		"chainId": hoodiChainID, "transactionHash": transactionHash, "logIndex": logIndex,
		"blockNumber": 24680, "blockHash": "0x" + strings.Repeat("8", 64),
		"contractAddress": collection, "eventName": "Transfer", "removed": false, "confirmations": 0,
		"payload": map[string]any{"from": "0x0000000000000000000000000000000000000000", "to": owner, "tokenId": "1"},
	}
	headers := map[string]string{"X-Indexer-Key": indexerKey}
	for _, step := range []struct {
		confirmations uint32
		removed       bool
		blockHash     string
		status        int
		confirmed     bool
	}{
		{0, false, "8", http.StatusCreated, false},
		{1, false, "8", http.StatusOK, true},
		{0, true, "8", http.StatusOK, true},
		{1, false, "9", http.StatusOK, true},
		{0, false, "9", http.StatusOK, true},
	} {
		body["confirmations"], body["removed"] = step.confirmations, step.removed
		body["blockHash"] = "0x" + strings.Repeat(step.blockHash, 64)
		response := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
		if response.Code != step.status {
			t.Fatalf("ingest NFT: status=%d body=%s", response.Code, response.Body.String())
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		db, handler = openService()
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM portfolio_deltas WHERE chain_id = ? AND transaction_hash = ? AND log_index = ?", hoodiChainID, transactionHash, logIndex).Scan(&count); err != nil || count != 0 {
			t.Fatalf("NFT created fungible balances after restart: count=%d err=%v", count, err)
		}
		var removed, confirmed bool
		var tokenID, blockHash, contract, eventName string
		if err := db.QueryRow(`SELECT removed, confirmed, JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenId')),
			LOWER(block_hash), LOWER(contract_address), event_name FROM chain_events
			WHERE chain_id = ? AND transaction_hash = ? AND log_index = ?`, hoodiChainID, transactionHash, logIndex).
			Scan(&removed, &confirmed, &tokenID, &blockHash, &contract, &eventName); err != nil {
			t.Fatal(err)
		}
		if removed != step.removed || confirmed != step.confirmed ||
			tokenID != "1" || blockHash != body["blockHash"] || contract != collection || eventName != "Transfer" {
			t.Fatalf("NFT canonical event drift: removed=%t confirmed=%t token=%s block=%s contract=%s event=%s", removed, confirmed, tokenID, blockHash, contract, eventName)
		}
	}
	body["payload"].(map[string]any)["tokenId"] = "2"
	if response := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers); response.Code != http.StatusConflict {
		t.Fatalf("replay changed NFT identity: status=%d body=%s", response.Code, response.Body.String())
	}
}
