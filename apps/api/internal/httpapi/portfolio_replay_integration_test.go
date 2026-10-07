package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMySQLPortfolioConfirmationReplaySurvivesRestart(t *testing.T) {
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("ARTFI_INTEGRATION_MYSQL_DSN is not set; real MySQL replay/restart is unverified")
	}
	const owner = "0x7373737373737373737373737373737373737373"
	const token = "0x7474747474747474747474747474747474747474"
	const balance = "7000000000000000001"
	transactionHash := "0x" + strings.Repeat("9", 64)
	const logIndex = 7
	const indexerKey = "portfolio-confirmation-replay-test-key"
	headers := map[string]string{"X-Indexer-Key": indexerKey}

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
			t.Fatalf("portfolio replay MySQL unavailable: %v", err)
		}
		service := newRWAService(rwaConfig{}, newMemoryObjectStore())
		service.db = db
		service.indexerKeyHash = sha256.Sum256([]byte(indexerKey))
		service.indexerEnabled = true
		// Exercise cached reads as well as SQL. Each restart has a fresh cache.
		service.cache = &memoryCache{values: map[string]string{}}
		return db, newHandler(service)
	}
	db, handler := openService()
	cleanup := func() {
		t.Helper()
		for _, table := range []string{"portfolio_deltas", "chain_events"} {
			if _, err := db.Exec("DELETE FROM "+table+" WHERE chain_id = ? AND transaction_hash = ? AND log_index = ?",
				hoodiChainID, transactionHash, logIndex); err != nil {
				t.Errorf("clean up portfolio replay %s: %v", table, err)
			}
		}
	}
	cleanup()
	defer cleanup()
	if t.Failed() {
		return
	}

	assertPortfolio := func(handler http.Handler, status string, removed bool) {
		t.Helper()
		response := requestWithHandler(t, handler, http.MethodGet, "/v1/portfolio/"+owner)
		if response.Code != http.StatusOK {
			t.Fatalf("read portfolio: status=%d body=%s", response.Code, response.Body.String())
		}
		var portfolio portfolioResponse
		decode(t, response, &portfolio)
		if len(portfolio.Transactions) != 1 || portfolio.Transactions[0].TransactionHash != transactionHash ||
			portfolio.Transactions[0].EventName != "Transfer" || portfolio.Transactions[0].Status != status {
			t.Fatalf("expected one %s transaction, got %+v", status, portfolio.Transactions)
		}
		if removed {
			if len(portfolio.Positions) != 0 {
				t.Fatalf("removed transfer still contributes to positions: %+v", portfolio.Positions)
			}
		} else if len(portfolio.Positions) != 1 || portfolio.Positions[0].AssetToken != token ||
			portfolio.Positions[0].Balance != balance {
			t.Fatalf("replay changed the unscaled balance: %+v", portfolio.Positions)
		}
	}
	body := map[string]any{
		"chainId":         hoodiChainID,
		"transactionHash": transactionHash,
		"logIndex":        logIndex,
		"blockNumber":     24680,
		"blockHash":       "0x" + strings.Repeat("8", 64),
		"contractAddress": token,
		"eventName":       "Transfer",
		"payload": map[string]any{
			"from":   "0x0000000000000000000000000000000000000000",
			"to":     owner,
			"value":  balance,
			"symbol": "FRC",
		},
	}
	for _, step := range []struct {
		name                string
		confirmations       uint32
		storedConfirmations uint32
		removed             bool
		status              string
		httpStatus          int
	}{
		{"initial observation", 0, 0, false, "pending", http.StatusCreated},
		{"unconfirmed replay", 0, 0, false, "pending", http.StatusOK},
		{"first confirmation", 1, 1, false, "confirmed", http.StatusOK},
		{"older replay cannot downgrade", 0, 1, false, "confirmed", http.StatusOK},
		{"removed takes priority", 5, 5, true, "removed", http.StatusOK},
		{"removed replay", 0, 5, true, "removed", http.StatusOK},
		{"canonical replay restores position", 0, 5, false, "confirmed", http.StatusOK},
	} {
		t.Log(step.name)
		body["confirmations"] = step.confirmations
		body["removed"] = step.removed
		response := jsonRequest(t, handler, http.MethodPost, "/v1/indexer/events", body, headers)
		if response.Code != step.httpStatus {
			t.Fatalf("ingest event: status=%d body=%s", response.Code, response.Body.String())
		}
		var confirmed, removed bool
		var confirmations uint32
		if err := db.QueryRow(`SELECT confirmed, removed, confirmations FROM chain_events
			WHERE chain_id = ? AND transaction_hash = ? AND log_index = ?`,
			hoodiChainID, transactionHash, logIndex).Scan(&confirmed, &removed, &confirmations); err != nil {
			t.Fatal(err)
		}
		if confirmed != (step.storedConfirmations > 0) || removed != step.removed || confirmations != step.storedConfirmations {
			t.Fatalf("stored event: confirmed=%t removed=%t confirmations=%d", confirmed, removed, confirmations)
		}
		assertPortfolio(handler, step.status, step.removed)
		// Drop the connection and service, then prove the projection comes from
		// committed SQL. This read also primes the cache before the next replay.
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		db, handler = openService()
		assertPortfolio(handler, step.status, step.removed)
	}
}
