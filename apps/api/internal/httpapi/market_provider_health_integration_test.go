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

	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	service.indexerEnabled = true
	service.indexerKeyHash = sha256.Sum256([]byte("provider-health-indexer-key"))
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 0, 45, 0, time.UTC) }
	handler := newHandler(service)
	report := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "healthy",
		"stale": false, "realtimeConnected": true, "consecutiveFailures": 0,
		"observedAt": "2026-09-14T00:00:30Z", "lastBackfillSuccessAt": "2026-09-14T00:00:00Z",
		"lastEventAt": "2026-09-14T00:00:20Z", "freshnessLagSeconds": 10,
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
	conflict := cloneMap(report)
	conflict["realtimeConnected"] = false
	conflicting := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", conflict, headers)
	if conflicting.Code != http.StatusConflict {
		t.Fatalf("same-time conflicting provider health: status=%d body=%s", conflicting.Code, conflicting.Body.String())
	}
	older := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "starting",
		"stale": true, "realtimeConnected": false, "consecutiveFailures": 0,
		"observedAt": "2026-09-13T23:59:59Z", "staleAfterSeconds": 60,
	}
	outOfOrder := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", older, headers)
	if outOfOrder.Code != http.StatusConflict {
		t.Fatalf("out-of-order provider health: status=%d body=%s", outOfOrder.Code, outOfOrder.Body.String())
	}
	degraded := map[string]any{
		"schemaVersion": "1", "source": "opensea", "state": "degraded",
		"stale": false, "realtimeConnected": true, "consecutiveFailures": 1,
		"observedAt": "2026-09-14T00:00:40Z", "lastBackfillSuccessAt": "2026-09-14T00:00:00Z",
		"lastEventAt": "2026-09-14T00:00:20Z", "lastFailureAt": "2026-09-14T00:00:40Z",
		"freshnessLagSeconds": 20, "staleAfterSeconds": 60,
	}
	updated := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/market-health", degraded, headers)
	if updated.Code != http.StatusOK {
		t.Fatalf("new provider health: status=%d body=%s", updated.Code, updated.Body.String())
	}
	service.now = func() time.Time { return time.Date(2026, 9, 14, 0, 2, 0, 0, time.UTC) }
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

func cloneMap(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}
