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
