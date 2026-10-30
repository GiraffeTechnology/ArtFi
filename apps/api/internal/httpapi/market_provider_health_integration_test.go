package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestMySQLMarketProviderHealthReplayConflictAndServerStaleness(t *testing.T) {
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
	if _, err := db.ExecContext(ctx, "DELETE FROM external_market_provider_health WHERE source = 'opensea'"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DELETE FROM external_market_provider_health WHERE source = 'opensea'")

	var databaseNow time.Time
	if err := db.QueryRowContext(ctx, "SELECT CURRENT_TIMESTAMP(6)").Scan(&databaseNow); err != nil {
		t.Fatal(err)
	}
	base := databaseNow.UTC().Truncate(time.Second)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("provider-health-indexer-key"))
	service.now = func() time.Time { return base.Add(45 * time.Second) }
	handler := newHandler(service)
	report := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "healthy",
		"stale": false, "realtimeConnected": true, "consecutiveFailures": 0,
		"observedAt": base.Add(30 * time.Second).Format(time.RFC3339Nano), "lastBackfillSuccessAt": base.Format(time.RFC3339Nano),
		"lastEventAt": base.Add(20 * time.Second).Format(time.RFC3339Nano), "freshnessLagSeconds": 10,
		"staleAfterSeconds": 60,
	}
	unauthorized := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", report,
		map[string]string{"X-Indexer-Key": "wrong"})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected indexer authentication rejection, got %d", unauthorized.Code)
	}
	headers := map[string]string{"X-Indexer-Key": "provider-health-indexer-key"}
	created := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", report, headers)
	if created.Code != http.StatusCreated {
		t.Fatalf("create provider health: status=%d body=%s", created.Code, created.Body.String())
	}
	replay := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", report, headers)
	if replay.Code != http.StatusOK {
		t.Fatalf("exact provider health replay: status=%d body=%s", replay.Code, replay.Body.String())
	}
	conflict := cloneMarketHealthMap(report)
	conflict["realtimeConnected"] = false
	conflicting := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", conflict, headers)
	if conflicting.Code != http.StatusConflict {
		t.Fatalf("same-time conflicting provider health: status=%d body=%s", conflicting.Code, conflicting.Body.String())
	}
	older := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "starting",
		"stale": true, "realtimeConnected": false, "consecutiveFailures": 0,
		"observedAt": base.Add(-1 * time.Second).Format(time.RFC3339Nano), "staleAfterSeconds": 60,
	}
	outOfOrder := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", older, headers)
	if outOfOrder.Code != http.StatusConflict {
		t.Fatalf("out-of-order provider health: status=%d body=%s", outOfOrder.Code, outOfOrder.Body.String())
	}
	degraded := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "degraded",
		"stale": false, "realtimeConnected": true, "consecutiveFailures": 1,
		"observedAt": base.Add(40 * time.Second).Format(time.RFC3339Nano), "lastBackfillSuccessAt": base.Add(0*time.Second).Format(time.RFC3339Nano),
		"lastEventAt": base.Add(20*time.Second).Format(time.RFC3339Nano), "lastFailureAt": base.Add(40 * time.Second).Format(time.RFC3339Nano),
		"freshnessLagSeconds": 20, "staleAfterSeconds": 60,
	}
	updated := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", degraded, headers)
	if updated.Code != http.StatusOK {
		t.Fatalf("new provider health: status=%d body=%s", updated.Code, updated.Body.String())
	}
	var storedReceived time.Time
	if err := db.QueryRowContext(ctx, "SELECT received_at FROM external_market_provider_health WHERE source = ?", "opensea").Scan(&storedReceived); err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return storedReceived.UTC().Add(61 * time.Second) }
	response := requestWithHandler(t, handler, http.MethodGet, "/v1/market/health?source=opensea")
	if response.Code != http.StatusOK {
		t.Fatalf("get provider health: status=%d body=%s", response.Code, response.Body.String())
	}
	var health marketProviderHealthResponse
	decode(t, response, &health)
	if !health.ReportingStale || health.Available || health.State != "degraded" || health.ConsecutiveFailures != 1 {
		t.Fatalf("unsafe provider health response: %+v", health)
	}
}

func cloneMarketHealthMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}
