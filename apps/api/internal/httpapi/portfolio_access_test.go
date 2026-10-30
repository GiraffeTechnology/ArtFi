package httpapi

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func configurePortfolioTestAuth(t *testing.T) {
	t.Helper()
	t.Setenv("ARTFI_USER_SESSION_SECRET", strings.Repeat("portfolio-session-test-", 3))
	t.Setenv("ARTFI_USER_AUTH_BRIDGE_TOKEN", strings.Repeat("portfolio-bridge-test-", 3))
	t.Setenv("ARTFI_WEB_ORIGIN", "https://artfi.test")
}
func authenticatedPortfolioRead(t *testing.T, handler http.Handler, db *sql.DB, address string) *httptest.ResponseRecorder {
	t.Helper()
	auth := &userAuthService{db: db, now: time.Now, jwtSecret: []byte(os.Getenv("ARTFI_USER_SESSION_SECRET")), bridgeToken: []byte(os.Getenv("ARTFI_USER_AUTH_BRIDGE_TOKEN")), origin: os.Getenv("ARTFI_WEB_ORIGIN")}
	tokens := walletAuthIntegrationLogin(t, auth, address)
	req := httptest.NewRequest(http.MethodGet, "/v1/portfolio/"+address, nil)
	req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}
func TestMySQLPortfolioEnforcesOwnerSessionAtGoBoundary(t *testing.T) {
	db, auth, _, address := walletAuthIntegrationFixture(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	handler := protectedPortfolio(service, auth)
	tokens := walletAuthIntegrationLogin(t, auth, address)
	check := func(owner, token string) int {
		req := httptest.NewRequest(http.MethodGet, "/v1/portfolio/"+owner, nil)
		req.SetPathValue("address", owner)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		result := httptest.NewRecorder()
		handler(result, req)
		if result.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("portfolio response was cacheable")
		}
		return result.Code
	}
	if status := check(address, ""); status != 401 {
		t.Fatalf("anonymous portfolio exposed: %d", status)
	}
	if status := check(userAuthTestAddress, tokens.AccessToken); status != 403 {
		t.Fatalf("another wallet exposed: %d", status)
	}
	if status := check(address, tokens.AccessToken); status != 200 {
		t.Fatalf("owner rejected: %d", status)
	}
	if _, err := db.Exec("UPDATE wallet_user_sessions SET revoked_at=NOW(6) WHERE session_id=?", tokens.Session.ID); err != nil {
		t.Fatal(err)
	}
	if status := check(address, tokens.AccessToken); status != 401 {
		t.Fatalf("revoked session read portfolio: %d", status)
	}
}
