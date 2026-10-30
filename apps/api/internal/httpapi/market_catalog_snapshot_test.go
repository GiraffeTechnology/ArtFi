package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type catalogSnapshotBeginFailure struct{ begins, queries int }

func (db *catalogSnapshotBeginFailure) BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error) {
	db.begins++
	return nil, errors.New("TEST_ONLY private database diagnostic")
}
func (db *catalogSnapshotBeginFailure) ExecContext(context.Context, string, ...any) (sql.Result, error) {
	return nil, errors.New("TEST_ONLY unexpected write")
}
func (db *catalogSnapshotBeginFailure) QueryContext(context.Context, string, ...any) (*sql.Rows, error) {
	db.queries++
	return nil, errors.New("TEST_ONLY unexpected pool read")
}

func TestMarketCatalogSnapshotBeginFailureReturnsUnavailableWithoutPoolFallback(t *testing.T) {
	db := &catalogSnapshotBeginFailure{}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	response := httptest.NewRecorder()
	service.getMarketAssets(response, httptest.NewRequest(http.MethodGet, "/v1/market/assets?source=opensea", nil))
	if response.Code != http.StatusServiceUnavailable || db.begins != 1 || db.queries != 0 {
		t.Fatalf("snapshot failure fell back to an inconsistent read: status=%d begin=%d query=%d", response.Code, db.begins, db.queries)
	}
	if strings.Contains(response.Body.String(), "TEST_ONLY") || strings.Contains(response.Body.String(), `"runtime":true`) || strings.Contains(response.Body.String(), `"data":`) {
		t.Fatal("unavailable snapshot exposed a diagnostic or successful catalog")
	}
}

// The wrapper uses a real MySQL transaction/read view and a different pooled
// connection for the concurrent writer. It also makes the old pool-only reader
// race deterministically by committing immediately after its count query.
type catalogSnapshotRaceDB struct {
	db       *sql.DB
	contract string
	mutate   func(context.Context) error
	mutated  bool
	began    bool
}

func (db *catalogSnapshotRaceDB) change(ctx context.Context) error {
	if db.mutated {
		return nil
	}
	db.mutated = true
	return db.mutate(ctx)
}
func (db *catalogSnapshotRaceDB) BeginTx(ctx context.Context, options *sql.TxOptions) (*sql.Tx, error) {
	if options == nil || !options.ReadOnly || options.Isolation != sql.LevelRepeatableRead {
		return nil, errors.New("TEST_ONLY repeatable read-only snapshot required")
	}
	tx, err := db.db.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	// Establish the real consistent read before the other connection commits.
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM external_market_events WHERE source=? AND contract_address=?", "opensea", db.contract).Scan(&count); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	if err := db.change(ctx); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	db.began = true
	return tx, nil
}
func (db *catalogSnapshotRaceDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return db.db.ExecContext(ctx, query, args...)
}
func (db *catalogSnapshotRaceDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	rows, err := db.db.QueryContext(ctx, query, args...)
	if err == nil && strings.Contains(query, "SELECT COUNT(*) FROM catalog") {
		if err := db.change(ctx); err != nil {
			_ = rows.Close()
			return nil, err
		}
	}
	return rows, err
}

func catalogSnapshotMySQL(t *testing.T) (*sql.DB, context.Context, string) {
	t.Helper()
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("NOT_RUN: catalog snapshot tests require the existing isolated integration MySQL DSN and migrations")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(4)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(func() { cancel(); _ = db.Close() })
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	contract := "0x" + randomID() + randomID()[:8]
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		for _, table := range []string{"external_market_orders", "external_market_events"} {
			if _, err := db.ExecContext(cleanup, "DELETE FROM "+table+" WHERE source=? AND contract_address=?", "opensea", contract); err != nil {
				t.Error(err)
			}
		}
	})
	return db, ctx, contract
}
func seedCatalogSnapshotEvent(ctx context.Context, db *sql.DB, contract, token string) error {
	id := sha256.Sum256([]byte(contract + ":" + token))
	_, err := db.ExecContext(ctx, `INSERT INTO external_market_events
		(event_id,schema_version,source,event_type,event_family,entity_key,event_version,chain_name,collection_slug,contract_address,token_id,event_timestamp,payload,payload_hash)
		VALUES (?,'1','opensea','item_metadata_updated','metadata',?,1,'ethereum','TEST_ONLY snapshot',?,?,?,'{}',UNHEX(SHA2('{}',256)))`,
		hex.EncodeToString(id[:]), contract+":"+token, contract, token, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC))
	return err
}
func catalogSnapshotResponse(t *testing.T, service *rwaService, contract, status string) (int, []marketAsset) {
	t.Helper()
	response := httptest.NewRecorder()
	service.getMarketAssets(response, httptest.NewRequest(http.MethodGet, "/v1/market/assets?source=opensea&contract="+contract+"&sort=token&listingStatus="+status, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("catalog unavailable: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Data    []marketAsset `json:"data"`
		Total   int           `json:"total"`
		Runtime bool          `json:"runtime"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Runtime {
		t.Fatal("real database snapshot was not identified as runtime data")
	}
	return result.Total, result.Data
}
func TestMySQLMarketCatalogSnapshotKeepsCountAndPageBeforeConcurrentInsert(t *testing.T) {
	db, ctx, contract := catalogSnapshotMySQL(t)
	if err := seedCatalogSnapshotEvent(ctx, db, contract, "1"); err != nil {
		t.Fatal(err)
	}
	race := &catalogSnapshotRaceDB{db: db, contract: contract, mutate: func(ctx context.Context) error { return seedCatalogSnapshotEvent(ctx, db, contract, "2") }}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = race
	total, items := catalogSnapshotResponse(t, service, contract, "all")
	if !race.began || !race.mutated || total != 1 || len(items) != 1 || items[0].TokenID != "1" {
		t.Fatalf("mixed indexer snapshots: total=%d items=%+v", total, items)
	}
	service.db = db
	total, items = catalogSnapshotResponse(t, service, contract, "all")
	if total != 2 || len(items) != 2 {
		t.Fatal("a new request did not observe the committed second token")
	}
}
func TestMySQLMarketCatalogSnapshotKeepsActiveFilterBeforeConcurrentCancellation(t *testing.T) {
	db, ctx, contract := catalogSnapshotMySQL(t)
	if err := seedCatalogSnapshotEvent(ctx, db, contract, "1"); err != nil {
		t.Fatal(err)
	}
	// A deterministic full-width test order identity, independent of credentials.
	digest := sha256.Sum256([]byte(contract + ":order"))
	orderHash := "0x" + hex.EncodeToString(digest[:])
	if _, err := db.ExecContext(ctx, `INSERT INTO external_market_orders
		(source,chain_name,order_hash,event_version,status,contract_address,token_id,event_timestamp,payload)
		VALUES ('opensea','ethereum',?,1,'active',?,'1',?,'{}')`, orderHash, contract, time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	race := &catalogSnapshotRaceDB{db: db, contract: contract, mutate: func(ctx context.Context) error {
		_, err := db.ExecContext(ctx, "UPDATE external_market_orders SET status='cancelled' WHERE source='opensea' AND chain_name='ethereum' AND order_hash=?", orderHash)
		return err
	}}
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = race
	total, items := catalogSnapshotResponse(t, service, contract, "active")
	if !race.began || !race.mutated || total != 1 || len(items) != 1 || items[0].OrderStatus != "active" {
		t.Fatalf("mixed order snapshots: total=%d items=%+v", total, items)
	}
	service.db = db
	total, items = catalogSnapshotResponse(t, service, contract, "active")
	if total != 0 || len(items) != 0 {
		t.Fatal("a new request did not observe the committed cancellation")
	}
}
