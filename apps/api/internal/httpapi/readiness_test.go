package httpapi

import (
	"database/sql"
	"net/http"
	"os"
	"testing"
)

func TestReadinessIsDistinctFromLiveness(t *testing.T) {
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.requireDB = true
	handler := newHandler(service)
	if response := requestWithHandler(t, handler, "GET", "/healthz"); response.Code != http.StatusOK {
		t.Fatalf("liveness %d", response.Code)
	}
	if response := requestWithHandler(t, handler, "GET", "/readyz"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness %d", response.Code)
	}
	service.requireDB = false
	if response := requestWithHandler(t, handler, "GET", "/readyz"); response.Code != http.StatusOK {
		t.Fatalf("isolated fixture readiness %d", response.Code)
	}
}
func TestMySQLReadinessChecksCurrentConnection(t *testing.T) {
	_, service, _, _, _ := catalogIntegrationFixture(t)
	db, err := sql.Open("mysql", os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	service.db = db
	service.requireDB = true
	handler := newHandler(service)
	if response := requestWithHandler(t, handler, "GET", "/readyz"); response.Code != http.StatusOK {
		t.Fatalf("connected readiness %d", response.Code)
	}
	// This fixture owns its pool; closing it models loss without altering a server or other tests.
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if response := requestWithHandler(t, handler, "GET", "/readyz"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("closed readiness %d", response.Code)
	}
}
