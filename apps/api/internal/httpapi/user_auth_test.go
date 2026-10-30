package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const userAuthTestAddress = "0x1111111111111111111111111111111111111111"

// This fake is used only for failures before persistence or unavailable DB tests.
// Durable behavior is covered by the real MySQL integration tests.
type unavailableUserAuthDB struct{}

func (unavailableUserAuthDB) BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error) {
	return nil, errors.New("test database unavailable")
}
func (unavailableUserAuthDB) ExecContext(context.Context, string, ...any) (sql.Result, error) {
	return nil, errors.New("test database unavailable")
}
func (unavailableUserAuthDB) QueryContext(context.Context, string, ...any) (*sql.Rows, error) {
	return nil, errors.New("test database unavailable")
}

func userAuthTestService(db persistenceDB, now func() time.Time) *userAuthService {
	return &userAuthService{db: db, now: now, origin: "https://artfi.test", jwtSecret: []byte(strings.Repeat("jwt-test-only-", 4)), bridgeToken: []byte(strings.Repeat("bridge-test-only-", 4))}
}

func userAuthBridgeRequest(service *userAuthService, path, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+string(service.bridgeToken))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestUserAuthBridgeRequiresDedicatedCredential(t *testing.T) {
	now := time.Date(2026, 10, 3, 1, 0, 0, 0, time.UTC)
	service := userAuthTestService(unavailableUserAuthDB{}, func() time.Time { return now })
	for _, credential := range []string{"", "Bearer browser-token", "Bearer operator-credential", "Bearer " + string(service.jwtSecret)} {
		request := userAuthBridgeRequest(service, "/v1/user/auth/challenge", `{}`)
		request.Header.Set("Authorization", credential)
		response := httptest.NewRecorder()
		service.trustedBridge(func(http.ResponseWriter, *http.Request) { t.Fatal("untrusted request reached handler") })(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status %d", response.Code)
		}
	}
	request := userAuthBridgeRequest(service, "/v1/user/auth/challenge", `{}`)
	response := httptest.NewRecorder()
	service.trustedBridge(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })(response, request)
	if response.Code != http.StatusNoContent || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("valid bridge response: %d", response.Code)
	}
}

func TestUserAuthFailsClosedWithoutPersistenceOrIndependentSecrets(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name   string
		mutate func(*userAuthService)
	}{
		{"no database", func(s *userAuthService) { s.db = nil }},
		{"missing JWT secret", func(s *userAuthService) { s.jwtSecret = nil }},
		{"short bridge credential", func(s *userAuthService) { s.bridgeToken = []byte("short") }},
		{"shared secrets", func(s *userAuthService) { s.bridgeToken = s.jwtSecret }},
		{"insecure origin", func(s *userAuthService) { s.origin = "http://artfi.test" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			service := userAuthTestService(unavailableUserAuthDB{}, func() time.Time { return now })
			test.mutate(service)
			response := httptest.NewRecorder()
			service.trustedBridge(func(http.ResponseWriter, *http.Request) { t.Fatal("unavailable auth reached handler") })(response, userAuthBridgeRequest(service, "/v1/user/auth/session", `{}`))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status %d", response.Code)
			}
			sellerRequest := httptest.NewRequest("POST", "/", nil)
			sellerRequest.Header.Set("Authorization", "Bearer supplied-session-token")
			if err := service.requireSeller(sellerRequest, userAuthTestAddress, hoodiChainID); !errors.Is(err, errUserAuthUnavailable) {
				t.Fatalf("seller did not fail closed: %v", err)
			}
		})
	}
}

func TestUserAccessJWTRejectsTamperingExpiryAndWrongBindings(t *testing.T) {
	now := time.Date(2026, 10, 3, 1, 0, 0, 0, time.UTC)
	service := userAuthTestService(unavailableUserAuthDB{}, func() time.Time { return now })
	session := userAuthSession{ID: strings.Repeat("a", 32), Address: userAuthTestAddress, ChainID: hoodiChainID, origin: service.origin, ExpiresAt: now.Add(userSessionLifetime).UnixMilli()}
	token, expiry, err := service.issueAccess(session)
	if err != nil || expiry != now.Add(userAccessLifetime).UnixMilli() {
		t.Fatalf("issue access: %d %v", expiry, err)
	}
	if _, err := service.parseAccess(token, false); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"attacker"}`)) + "." + parts[2]
	if _, err := service.parseAccess(tampered, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatal("tampered JWT accepted")
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	if _, err := service.parseAccess(header+"."+parts[1]+".", false); !errors.Is(err, errUserUnauthorized) {
		t.Fatal("unsigned JWT accepted")
	}
	now = now.Add(userAccessLifetime)
	if _, err := service.parseAccess(token, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatal("expired JWT accepted")
	}
	if _, err := service.parseAccess(token, true); err != nil {
		t.Fatalf("expired signed access cannot log out: %v", err)
	}
	now = now.Add(-userAccessLifetime)
	for _, test := range []struct {
		name   string
		mutate func(*userAccessClaims)
	}{
		{"chain", func(c *userAccessClaims) { c.ChainID = 1 }},
		{"origin", func(c *userAccessClaims) { c.Origin = "https://other.test" }},
		{"audience", func(c *userAccessClaims) { c.Audience = "operator" }},
		{"issuer", func(c *userAccessClaims) { c.Issuer = "other" }},
		{"future issued", func(c *userAccessClaims) { c.IssuedAt = now.Add(time.Minute).Unix() }},
		{"too long", func(c *userAccessClaims) { c.ExpiresAt = now.Add(11 * time.Minute).Unix() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			claims, _ := service.parseAccess(token, false)
			test.mutate(claims)
			body, _ := json.Marshal(claims)
			unsigned := parts[0] + "." + base64.RawURLEncoding.EncodeToString(body)
			mac := hmac.New(sha256.New, service.jwtSecret)
			_, _ = mac.Write([]byte(unsigned))
			altered := unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
			if _, err := service.parseAccess(altered, false); !errors.Is(err, errUserUnauthorized) {
				t.Fatalf("invalid claims accepted: %v", err)
			}
		})
	}
}

func TestUserChallengeMessageBindsWalletChainOriginAndTimes(t *testing.T) {
	now := time.Date(2026, 10, 3, 1, 0, 0, 0, time.UTC)
	challenge := userAuthChallenge{Address: userAuthTestAddress, ChainID: hoodiChainID, Origin: "https://artfi.test", nonce: strings.Repeat("b", 64), IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(userChallengeLifetime).UnixMilli()}
	message := userChallengeMessage(&challenge)
	for _, part := range []string{userAuthTestAddress, "Chain ID: 560048", "URI: https://artfi.test", "Nonce: " + challenge.nonce, "Issued At: 2026-10-03T01:00:00Z", "Expiration Time: 2026-10-03T01:05:00Z"} {
		if !strings.Contains(message, part) {
			t.Fatalf("missing binding %q", part)
		}
	}
}

func TestUserAuthErrorMapping(t *testing.T) {
	for _, test := range []struct {
		err    error
		status int
	}{{errUserUnauthorized, 401}, {errUserForbidden, 403}, {errUserAuthUnavailable, 503}, {errors.New("SQL unavailable"), 503}} {
		response := httptest.NewRecorder()
		writeUserAuthError(response, httptest.NewRequest("POST", "/", nil), test.err)
		if response.Code != test.status {
			t.Fatalf("%v: got %d want %d", test.err, response.Code, test.status)
		}
	}
}

func TestUserSellerMissingSessionIsUnauthorizedWithoutDatabase(t *testing.T) {
	service := userAuthTestService(nil, time.Now)
	request := httptest.NewRequest("POST", "/v1/market/signed-orders", nil)
	if err := service.requireSeller(request, userAuthTestAddress, hoodiChainID); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("missing session: %v", err)
	}
}
