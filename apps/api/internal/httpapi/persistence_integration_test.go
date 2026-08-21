package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMySQLPersistenceSurvivesServiceRestart(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cleanupPersistenceTables(t, ctx, db)
	defer cleanupPersistenceTables(t, context.Background(), db)

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.requireDB = true
	now := time.Date(2026, 8, 19, 5, 0, 0, 0, time.UTC)
	upload := &uploadSession{
		ID: "11111111111111111111111111111111", ObjectKey: "rwa/images/test.png",
		FileName: "test.png", ContentType: "image/png",
		SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Size:   68, CreatedAt: now,
	}
	if err := service.persistUpload(ctx, upload); err != nil {
		t.Fatal(err)
	}
	if err := service.persistUploadCompletion(ctx, upload.ID); err != nil {
		t.Fatal(err)
	}

	mint := &mintIntent{
		IntentID:        "22222222222222222222222222222222",
		RequestID:       "0x" + "bb" + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Recipient:       "0x2222222222222222222222222222222222222222",
		RegistryAddress: "0x3333333333333333333333333333333333333333",
		ChainID:         sepoliaChainID,
		MetadataURI:     "https://assets.test/metadata.json",
		MetadataSHA256:  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		Status:          "prepared", CreatedAt: now.Format(time.RFC3339),
		payloadHash:        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		uploadID:           upload.ID,
		idempotencyKeyHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	}
	if err := service.persistMintIntent(ctx, mint); err != nil {
		t.Fatal(err)
	}
	if err := service.persistSubmission(ctx, mint.IntentID, "0x"+"f0"+"00000000000000000000000000000000000000000000000000000000000000"); err != nil {
		t.Fatal(err)
	}

	vault := &vaultIntent{
		IntentID:          "33333333333333333333333333333333",
		RequestID:         "0x1111111111111111111111111111111111111111111111111111111111111111",
		FactoryAddress:    "0x4444444444444444444444444444444444444444",
		CollectionAddress: "0x5555555555555555555555555555555555555555",
		TokenID:           "1", VaultName: "Restart Vault",
		AdminAddress:          "0x6666666666666666666666666666666666666666",
		PauserAddress:         "0x7777777777777777777777777777777777777777",
		FractionalizerAddress: "0x8888888888888888888888888888888888888888",
		Status:                "prepared", CreatedAt: now.Format(time.RFC3339),
		payloadHash:        "9999999999999999999999999999999999999999999999999999999999999999",
		idempotencyKeyHash: "abababababababababababababababababababababababababababababababab",
	}
	if err := service.persistVaultIntent(ctx, vault); err != nil {
		t.Fatal(err)
	}
	if err := service.persistVaultSubmission(ctx, vault.IntentID, "0x"+"cd"+"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"); err != nil {
		t.Fatal(err)
	}

	restarted := newRWAService(rwaConfig{}, newMemoryObjectStore())
	restarted.db = db
	if err := restarted.hydratePersistence(ctx); err != nil {
		t.Fatal(err)
	}
	if !restarted.uploads[upload.ID].Completed {
		t.Fatal("completed upload was not recovered")
	}
	if recovered := restarted.intents[mint.IntentID]; recovered == nil || recovered.Status != "submitted" {
		t.Fatalf("mint intent not recovered: %+v", recovered)
	}
	if recovered := restarted.vaultIntents[vault.IntentID]; recovered == nil || recovered.Status != "submitted" {
		t.Fatalf("vault intent not recovered: %+v", recovered)
	}
}

func TestMySQLChainEventDedupeConflictAndReorg(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("DELETE FROM chain_events"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DELETE FROM chain_events")

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerKeyHash = sha256.Sum256([]byte("stage4-indexer-test-key"))
	service.indexerEnabled = true
	handler := newHandler(service)
	body := map[string]any{
		"chainId":         sepoliaChainID,
		"transactionHash": "0x" + strings.Repeat("a", 64),
		"logIndex":        2,
		"blockNumber":     12345,
		"blockHash":       "0x" + strings.Repeat("b", 64),
		"contractAddress": "0x1111111111111111111111111111111111111111",
		"eventName":       "Transfer",
		"payload": map[string]any{
			"from":   "0x0000000000000000000000000000000000000000",
			"to":     "0x2222222222222222222222222222222222222222",
			"value":  "7",
			"symbol": "FRC",
		},
		"removed":       false,
		"confirmations": 3,
	}
	unauthorized := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, map[string]string{"X-Indexer-Key": "wrong-key"})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", unauthorized.Code)
	}
	headers := map[string]string{"X-Indexer-Key": "stage4-indexer-test-key"}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
	if created.Code != http.StatusCreated {
		t.Fatalf("create event: status=%d body=%s", created.Code, created.Body.String())
	}
	portfolio := requestWithHandler(t, handler, http.MethodGet, "/v1/portfolio/0x2222222222222222222222222222222222222222")
	var projected portfolioResponse
	decode(t, portfolio, &projected)
	if len(projected.Positions) != 1 || projected.Positions[0].Balance != "7" {
		t.Fatalf("transfer was not projected: %+v", projected.Positions)
	}
	if len(projected.Transactions) != 1 || projected.Transactions[0].EventName != "Transfer" || projected.Transactions[0].Status != "confirmed" {
		t.Fatalf("transaction history was not projected: %+v", projected.Transactions)
	}
	mintBody := map[string]any{
		"chainId":         11155111,
		"transactionHash": "0x" + strings.Repeat("d", 64),
		"logIndex":        3,
		"blockNumber":     12346,
		"blockHash":       "0x" + strings.Repeat("e", 64),
		"contractAddress": "0x1111111111111111111111111111111111111111",
		"eventName":       "AssetCreated",
		"payload": map[string]any{
			"collectionAddress": "0x1111111111111111111111111111111111111111",
			"tokenId":           "7",
			"recipient":         "0x2222222222222222222222222222222222222222",
			"metadataURI":       "https://example.test/metadata/7.json",
		},
		"removed":       false,
		"confirmations": 3,
	}
	mintCreated := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", mintBody, headers)
	if mintCreated.Code != http.StatusCreated {
		t.Fatalf("create mint event: status=%d body=%s", mintCreated.Code, mintCreated.Body.String())
	}
	catalog := requestWithHandler(t, handler, http.MethodGet, "/v1/nfts?page=1&pageSize=20")
	var indexed struct {
		Data  []mintedNFT `json:"data"`
		Total int         `json:"total"`
	}
	decode(t, catalog, &indexed)
	if indexed.Total != 1 || len(indexed.Data) != 1 || indexed.Data[0].Standard != "ERC-721" || indexed.Data[0].TokenID != "7" {
		t.Fatalf("minted NFT catalog was not projected: %+v", indexed)
	}
	replay := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay event: status=%d body=%s", replay.Code, replay.Body.String())
	}
	body["payload"] = map[string]any{"from": "0x0000000000000000000000000000000000000000", "to": "0x2222222222222222222222222222222222222222", "value": "8", "symbol": "FRC"}
	conflict := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("expected payload conflict, got %d", conflict.Code)
	}
	body["payload"] = map[string]any{"from": "0x0000000000000000000000000000000000000000", "to": "0x2222222222222222222222222222222222222222", "value": "7", "symbol": "FRC"}
	body["removed"] = true
	removed := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
	if removed.Code != http.StatusOK {
		t.Fatalf("remove event: status=%d body=%s", removed.Code, removed.Body.String())
	}
	portfolio = requestWithHandler(t, handler, http.MethodGet, "/v1/portfolio/0x2222222222222222222222222222222222222222")
	decode(t, portfolio, &projected)
	if len(projected.Positions) != 0 {
		t.Fatalf("removed transfer still projected: %+v", projected.Positions)
	}
	body["removed"] = false
	body["blockHash"] = "0x" + strings.Repeat("c", 64)
	reorged := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
	if reorged.Code != http.StatusOK {
		t.Fatalf("reorg replacement: status=%d body=%s", reorged.Code, reorged.Body.String())
	}
}

func TestMySQLExternalMarketMirrorDedupeAndOrdering(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{"DELETE FROM external_market_orders", "DELETE FROM external_market_events"} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	defer db.Exec("DELETE FROM external_market_orders")
	defer db.Exec("DELETE FROM external_market_events")

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerKeyHash = sha256.Sum256([]byte("external-market-indexer-key"))
	service.indexerEnabled = true
	handler := newHandler(service)
	orderHash := "0x" + strings.Repeat("d", 64)
	body := map[string]any{
		"schemaVersion":   "1",
		"source":          "opensea",
		"eventType":       "item_listed",
		"eventFamily":     "order",
		"entityKey":       orderHash,
		"version":         7,
		"chain":           "ethereum",
		"collectionSlug":  "artfi-test",
		"orderHash":       orderHash,
		"contractAddress": "0x1111111111111111111111111111111111111111",
		"tokenId":         "42",
		"makerAddress":    "0x2222222222222222222222222222222222222222",
		"price":           "1000000000000000",
		"paymentSymbol":   "ETH",
		"marketplaceUrl":  "https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/42",
		"eventTimestamp":  "2026-08-19T04:00:00Z",
		"payload":         map[string]any{"order_hash": orderHash},
	}
	unauthorized := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, map[string]string{"X-Indexer-Key": "wrong"})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized, got %d", unauthorized.Code)
	}
	headers := map[string]string{"X-Indexer-Key": "external-market-indexer-key"}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if created.Code != http.StatusCreated {
		t.Fatalf("create mirror event: status=%d body=%s", created.Code, created.Body.String())
	}
	replay := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay mirror event: status=%d body=%s", replay.Code, replay.Body.String())
	}

	body["eventType"] = "item_cancelled"
	body["version"] = 8
	body["eventTimestamp"] = "2026-08-19T04:00:01Z"
	cancelled := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if cancelled.Code != http.StatusCreated {
		t.Fatalf("cancel mirror event: status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	body["eventType"] = "item_listed"
	body["version"] = 6
	body["eventTimestamp"] = "2026-08-19T03:59:59Z"
	stale := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if stale.Code != http.StatusCreated {
		t.Fatalf("stale mirror event should remain auditable: status=%d body=%s", stale.Code, stale.Body.String())
	}
	var status string
	var version uint64
	if err := db.QueryRow("SELECT status, event_version FROM external_market_orders WHERE source = 'opensea' AND chain_name = 'ethereum' AND order_hash = ?", orderHash).Scan(&status, &version); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" || version != 8 {
		t.Fatalf("stale event overwrote canonical order: status=%s version=%d", status, version)
	}
	body["eventType"] = "item_sold"
	body["eventFamily"] = "sale"
	body["version"] = 1
	body["transactionHash"] = "0x" + strings.Repeat("e", 64)
	body["eventTimestamp"] = "2026-08-19T04:00:02Z"
	sold := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if sold.Code != http.StatusCreated {
		t.Fatalf("sale mirror event: status=%d body=%s", sold.Code, sold.Body.String())
	}
	body["eventType"] = "item_listed"
	body["eventFamily"] = "order"
	body["version"] = 99
	body["eventTimestamp"] = "2026-08-19T04:00:03Z"
	lateListing := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", body, headers)
	if lateListing.Code != http.StatusCreated {
		t.Fatalf("late listing remains auditable: status=%d body=%s", lateListing.Code, lateListing.Body.String())
	}
	var fulfilledAt, fulfillmentTransactionHash string
	if err := db.QueryRow(`
		SELECT status, event_version, DATE_FORMAT(fulfilled_at, '%Y-%m-%dT%H:%i:%s.%fZ'), fulfillment_transaction_hash
		FROM external_market_orders
		WHERE source = 'opensea' AND chain_name = 'ethereum' AND order_hash = ?`, orderHash).
		Scan(&status, &version, &fulfilledAt, &fulfillmentTransactionHash); err != nil {
		t.Fatal(err)
	}
	if status != "fulfilled" || version != 8 || fulfilledAt == "" || fulfillmentTransactionHash != body["transactionHash"] {
		t.Fatalf("fulfilled order was not terminal: status=%s version=%d fulfilledAt=%s tx=%s", status, version, fulfilledAt, fulfillmentTransactionHash)
	}
	activity := requestWithHandler(t, handler, http.MethodGet, "/v1/market/activity?source=opensea&limit=10")
	if activity.Code != http.StatusOK || !strings.Contains(activity.Body.String(), "external-deeplink-only") {
		t.Fatalf("market activity boundary missing: status=%d body=%s", activity.Code, activity.Body.String())
	}
}

func TestMySQLExternalTradeIntentUsesOpenSeaPlanAndReconcilesResult(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		"DELETE FROM marketplace_discovery_checks",
		"DELETE FROM external_market_intents",
		"DELETE FROM external_market_orders",
		"DELETE FROM external_market_events",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	defer db.Exec("DELETE FROM external_market_intents")
	defer db.Exec("DELETE FROM external_market_orders")
	defer db.Exec("DELETE FROM external_market_events")

	orderHash := "0x" + strings.Repeat("1", 64)
	transactionHash := "0x" + strings.Repeat("2", 64)
	protocolAddress := "0x3333333333333333333333333333333333333333"
	mockOpenSea := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/v2/listings/cross_chain_fulfillment_data" ||
			request.Header.Get("X-API-Key") != "test-opensea-key" {
			t.Fatalf("unexpected OpenSea request: %s %s", request.Method, request.URL.Path)
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"transactions": []map[string]string{{
				"chain": "ethereum", "to": protocolAddress, "data": "0x1234",
				"value": "1000000000000000", "value_hex": "0x038d7ea4c68000",
			}},
		})
	}))
	defer mockOpenSea.Close()

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerKeyHash = sha256.Sum256([]byte("trade-intent-indexer-key"))
	service.indexerEnabled = true
	service.externalTradeEnabled = true
	service.openseaAPIKey = "test-opensea-key"
	service.openseaAPIBaseURL = mockOpenSea.URL
	handler := newHandler(service)
	listed := map[string]any{
		"schemaVersion": "1", "source": "opensea", "eventType": "item_listed",
		"eventFamily": "order", "entityKey": orderHash, "version": 1,
		"chain": "ethereum", "collectionSlug": "artfi-test", "orderHash": orderHash,
		"contractAddress": "0x4444444444444444444444444444444444444444",
		"tokenId":         "42", "makerAddress": "0x5555555555555555555555555555555555555555",
		"price": "1000000000000000", "paymentSymbol": "ETH",
		"marketplaceUrl": "https://opensea.io/assets/ethereum/0x4444444444444444444444444444444444444444/42",
		"eventTimestamp": "2026-08-19T05:00:00Z",
		"payload":        map[string]any{"order_hash": orderHash, "protocol_address": protocolAddress},
	}
	indexed := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", listed,
		map[string]string{"X-Indexer-Key": "trade-intent-indexer-key"})
	if indexed.Code != http.StatusCreated {
		t.Fatalf("index listing: status=%d body=%s", indexed.Code, indexed.Body.String())
	}
	catalog := requestWithHandler(t, handler, http.MethodGet, "/v1/market/assets?source=opensea&pageSize=100")
	if catalog.Code != http.StatusOK || !strings.Contains(catalog.Body.String(), `"total":1`) ||
		!strings.Contains(catalog.Body.String(), orderHash) {
		t.Fatalf("runtime catalog missing listing: status=%d body=%s", catalog.Code, catalog.Body.String())
	}

	intentRequest := map[string]any{
		"source": "opensea", "action": "fulfill-listing", "chain": "ethereum",
		"orderHash": orderHash, "walletAddress": "0x6666666666666666666666666666666666666666",
	}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/market/intents", intentRequest,
		map[string]string{"Idempotency-Key": "trade-intent-idempotency-key"})
	if created.Code != http.StatusCreated {
		t.Fatalf("create trade intent: status=%d body=%s", created.Code, created.Body.String())
	}
	var intent marketIntent
	decode(t, created, &intent)
	if intent.Status != "awaiting-wallet" || len(intent.Transactions) != 1 ||
		intent.Transactions[0].To != protocolAddress {
		t.Fatalf("unsafe or incomplete transaction plan: %+v", intent)
	}
	replay := jsonRequest(t, handler, http.MethodPost, "/v1/market/intents", intentRequest,
		map[string]string{"Idempotency-Key": "trade-intent-idempotency-key"})
	if replay.Code != http.StatusOK {
		t.Fatalf("idempotent intent replay: status=%d body=%s", replay.Code, replay.Body.String())
	}
	submitted := jsonRequest(t, handler, http.MethodPost, "/v1/market/intents/"+intent.IntentID+"/submission",
		map[string]any{"transactionHash": transactionHash}, nil)
	if submitted.Code != http.StatusOK || !strings.Contains(submitted.Body.String(), `"status":"submitted"`) {
		t.Fatalf("record trade submission: status=%d body=%s", submitted.Code, submitted.Body.String())
	}

	listed["eventType"] = "item_sold"
	listed["eventFamily"] = "sale"
	listed["version"] = 2
	listed["transactionHash"] = transactionHash
	listed["eventTimestamp"] = "2026-08-19T05:00:02Z"
	sold := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-events", listed,
		map[string]string{"X-Indexer-Key": "trade-intent-indexer-key"})
	if sold.Code != http.StatusCreated {
		t.Fatalf("reconcile sale: status=%d body=%s", sold.Code, sold.Body.String())
	}
	result := requestWithHandler(t, handler, http.MethodGet, "/v1/market/intents/"+intent.IntentID)
	if result.Code != http.StatusOK || !strings.Contains(result.Body.String(), `"status":"confirmed"`) ||
		!strings.Contains(result.Body.String(), transactionHash) {
		t.Fatalf("confirmed result missing: status=%d body=%s", result.Code, result.Body.String())
	}
}

func requestWithHandler(t *testing.T, handler http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func cleanupPersistenceTables(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	for _, statement := range []string{
		"DELETE FROM external_market_intents",
		"DELETE FROM external_market_orders",
		"DELETE FROM external_market_events",
		"DELETE FROM chain_events",
		"DELETE FROM fractionalizations",
		"DELETE FROM vaults",
		"DELETE FROM rwa_mint_intents",
		"DELETE FROM rwa_uploads",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("cleanup persistence: %v", err)
		}
	}
}
