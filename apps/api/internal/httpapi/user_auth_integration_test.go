package httpapi

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func walletAuthIntegrationFixture(t *testing.T) (*sql.DB, *userAuthService, *time.Time, string) {
	t.Helper()
	dsn := os.Getenv("ARTFI_INTEGRATION_MYSQL_DSN")
	if dsn == "" {
		t.Skip("UNVERIFIED: real wallet-session SQL tests require ARTFI_INTEGRATION_MYSQL_DSN and migrations 000001-000010")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(12)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("wallet auth integration MySQL unavailable: %v", err)
	}
	if _, err := db.ExecContext(ctx, "SELECT session_id FROM wallet_user_sessions LIMIT 0"); err != nil {
		t.Fatalf("apply wallet auth migration 000010 first: %v", err)
	}
	random, err := userRandomToken(20)
	if err != nil {
		t.Fatal(err)
	}
	address := "0x" + random
	now := time.Date(2026, 10, 3, 1, 0, 0, 0, time.UTC)
	service := userAuthTestService(db, func() time.Time { return now })
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), "DELETE FROM wallet_user_sessions WHERE wallet_address = ?", address); err != nil {
			t.Error(err)
		}
		if _, err := db.ExecContext(context.Background(), "DELETE FROM wallet_user_challenges WHERE wallet_address = ?", address); err != nil {
			t.Error(err)
		}
	})
	return db, service, &now, address
}

func walletAuthIntegrationChallenge(t *testing.T, service *userAuthService, address string) *userAuthChallenge {
	t.Helper()
	challenge, err := service.createChallenge(context.Background(), userChallengeInput{Address: address, ChainID: hoodiChainID, Origin: service.origin})
	if err != nil {
		t.Fatal(err)
	}
	return challenge
}

func walletAuthProof(challenge *userAuthChallenge) userVerifyInput {
	return userVerifyInput{ChallengeID: challenge.ID, Address: challenge.Address, ChainID: challenge.ChainID, Origin: challenge.Origin, Message: challenge.Message}
}

func walletAuthIntegrationLogin(t *testing.T, service *userAuthService, address string) *userAuthTokens {
	t.Helper()
	tokens, err := service.consumeChallenge(context.Background(), walletAuthProof(walletAuthIntegrationChallenge(t, service, address)))
	if err != nil {
		t.Fatal(err)
	}
	return tokens
}

func TestMySQLWalletAuthChallengeBindingExpiryAndReplay(t *testing.T) {
	_, service, now, address := walletAuthIntegrationFixture(t)
	challenge := walletAuthIntegrationChallenge(t, service, address)
	for _, test := range []struct {
		name   string
		mutate func(*userVerifyInput)
	}{
		{"wallet", func(p *userVerifyInput) { p.Address = userAuthTestAddress }},
		{"chain", func(p *userVerifyInput) { p.ChainID = 1 }},
		{"origin", func(p *userVerifyInput) { p.Origin = "https://other.test" }},
		{"message", func(p *userVerifyInput) { p.Message += " altered" }},
		{"challenge", func(p *userVerifyInput) { p.ChallengeID = strings.Repeat("f", 32) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			proof := walletAuthProof(challenge)
			test.mutate(&proof)
			if _, err := service.consumeChallenge(context.Background(), proof); !errors.Is(err, errUserUnauthorized) {
				t.Fatalf("invalid binding accepted or SQL failed: %v", err)
			}
		})
	}
	if _, err := service.consumeChallenge(context.Background(), walletAuthProof(challenge)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.consumeChallenge(context.Background(), walletAuthProof(challenge)); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("nonce replay accepted: %v", err)
	}
	expired := walletAuthIntegrationChallenge(t, service, address)
	*now = now.Add(userChallengeLifetime)
	if _, err := service.consumeChallenge(context.Background(), walletAuthProof(expired)); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("expired challenge accepted: %v", err)
	}
}

func TestMySQLWalletAuthConcurrentNonceSingleUse(t *testing.T) {
	db, service, _, address := walletAuthIntegrationFixture(t)
	challenge := walletAuthIntegrationChallenge(t, service, address)
	start := make(chan struct{})
	outcomes := make(chan error, 12)
	var workers sync.WaitGroup
	for range 12 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := service.consumeChallenge(context.Background(), walletAuthProof(challenge))
			outcomes <- err
		}()
	}
	close(start)
	workers.Wait()
	close(outcomes)
	successes := 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else if !errors.Is(err, errUserUnauthorized) {
			t.Fatalf("concurrent challenge SQL failure: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("nonce consumed %d times", successes)
	}
	var sessions int
	if err := db.QueryRow("SELECT COUNT(*) FROM wallet_user_sessions WHERE wallet_address = ?", address).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("persisted %d sessions for one nonce", sessions)
	}
}

func TestMySQLWalletAuthRefreshRotationReplayAndRestart(t *testing.T) {
	db, service, now, address := walletAuthIntegrationFixture(t)
	original := walletAuthIntegrationLogin(t, service, address)
	restarted := userAuthTestService(db, func() time.Time { return *now })
	if _, err := restarted.authenticate(context.Background(), original.AccessToken, false); err != nil {
		t.Fatalf("restart lost login: %v", err)
	}
	rotated, err := restarted.rotateRefresh(context.Background(), original.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.RefreshToken == original.RefreshToken || rotated.Session.ExpiresAt != original.Session.ExpiresAt {
		t.Fatal("refresh failed to rotate or extended absolute session")
	}
	var storedHash string
	if err := db.QueryRow("SELECT LOWER(HEX(token_hash)) FROM wallet_user_refresh_tokens WHERE token_hash = ?", userTokenHash(rotated.RefreshToken)).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash != hex.EncodeToString(userTokenHash(rotated.RefreshToken)) || storedHash == rotated.RefreshToken {
		t.Fatal("raw refresh token stored")
	}
	if _, err := restarted.rotateRefresh(context.Background(), original.RefreshToken); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("used refresh was accepted: %v", err)
	}
	secondRestart := userAuthTestService(db, func() time.Time { return *now })
	if _, err := secondRestart.authenticate(context.Background(), rotated.AccessToken, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("replay revocation lost on restart: %v", err)
	}
	if _, err := secondRestart.rotateRefresh(context.Background(), rotated.RefreshToken); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("replay did not revoke replacement: %v", err)
	}
}

func TestMySQLWalletAuthConcurrentRefreshRevokesWinner(t *testing.T) {
	_, service, _, address := walletAuthIntegrationFixture(t)
	original := walletAuthIntegrationLogin(t, service, address)
	type outcome struct {
		tokens *userAuthTokens
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			tokens, err := service.rotateRefresh(context.Background(), original.RefreshToken)
			outcomes <- outcome{tokens, err}
		}()
	}
	close(start)
	workers.Wait()
	close(outcomes)
	var winner *userAuthTokens
	successes := 0
	for result := range outcomes {
		if result.err == nil {
			winner = result.tokens
			successes++
		} else if !errors.Is(result.err, errUserUnauthorized) {
			t.Fatalf("concurrent refresh SQL failure: %v", result.err)
		}
	}
	if successes != 1 {
		t.Fatalf("refresh had %d winners", successes)
	}
	if _, err := service.authenticate(context.Background(), winner.AccessToken, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("concurrent replay did not revoke winner: %v", err)
	}
}

func TestMySQLWalletAuthSellerGuardExpiryAndLogout(t *testing.T) {
	db, service, now, address := walletAuthIntegrationFixture(t)
	tokens := walletAuthIntegrationLogin(t, service, address)
	request := httptest.NewRequest("POST", "/v1/market/signed-orders", nil)
	request.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
	if err := service.requireSeller(request, address, hoodiChainID); err != nil {
		t.Fatalf("matching seller rejected: %v", err)
	}
	if err := service.requireSeller(request, userAuthTestAddress, hoodiChainID); !errors.Is(err, errUserForbidden) {
		t.Fatalf("mismatched seller not forbidden: %v", err)
	}
	if err := service.requireSeller(request, address, 1); !errors.Is(err, errUserForbidden) {
		t.Fatalf("mismatched chain not forbidden: %v", err)
	}
	*now = now.Add(userAccessLifetime)
	if err := service.requireSeller(request, address, hoodiChainID); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("expired access accepted: %v", err)
	}
	body, _ := json.Marshal(map[string]string{"accessToken": tokens.AccessToken})
	response := httptest.NewRecorder()
	service.trustedBridge(service.logout)(response, userAuthBridgeRequest(service, "/v1/user/auth/logout", string(body)))
	if response.Code != http.StatusNoContent {
		t.Fatalf("expired signed access logout status %d: %s", response.Code, response.Body.String())
	}
	restarted := userAuthTestService(db, func() time.Time { return *now })
	if _, err := restarted.rotateRefresh(context.Background(), tokens.RefreshToken); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("logout revocation was not durable: %v", err)
	}
	second := walletAuthIntegrationLogin(t, service, address)
	if err := service.revokeUserSession(context.Background(), "", second.RefreshToken); err != nil {
		t.Fatal(err)
	}
	if _, err := service.authenticate(context.Background(), second.AccessToken, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("logout refresh did not revoke access: %v", err)
	}
}

func TestMySQLWalletAuthAbsoluteSessionExpiryDoesNotSlide(t *testing.T) {
	_, service, now, address := walletAuthIntegrationFixture(t)
	tokens := walletAuthIntegrationLogin(t, service, address)
	*now = now.Add(userSessionLifetime - time.Minute)
	rotated, err := service.rotateRefresh(context.Background(), tokens.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Session.ExpiresAt != tokens.Session.ExpiresAt || rotated.Session.AccessExpiresAt != tokens.Session.ExpiresAt {
		t.Fatal("refresh/access extended past absolute session expiry")
	}
	*now = now.Add(time.Minute)
	if _, err := service.authenticate(context.Background(), rotated.AccessToken, false); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("absolute-expired access accepted: %v", err)
	}
	if _, err := service.rotateRefresh(context.Background(), rotated.RefreshToken); !errors.Is(err, errUserUnauthorized) {
		t.Fatalf("absolute-expired refresh accepted: %v", err)
	}
}

func TestMySQLWalletAuthTransactionsRollback(t *testing.T) {
	db, service, _, address := walletAuthIntegrationFixture(t)
	challenge := walletAuthIntegrationChallenge(t, service, address)
	suffix, err := userRandomToken(8)
	if err != nil {
		t.Fatal(err)
	}
	trigger := "wallet_auth_rollback_" + suffix
	// The real DB rejects a later statement, after the challenge update, proving
	// that no partial consumption survives the failed transaction.
	query := fmt.Sprintf("CREATE TRIGGER %s BEFORE INSERT ON wallet_user_sessions FOR EACH ROW BEGIN IF NEW.wallet_address = '%s' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test insert failure'; END IF; END", trigger, address)
	if _, err := db.Exec(query); err != nil {
		t.Fatalf("rollback test requires CREATE TRIGGER on the isolated integration DB: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP TRIGGER IF EXISTS " + trigger) })
	if _, err := service.consumeChallenge(context.Background(), walletAuthProof(challenge)); err == nil || errors.Is(err, errUserUnauthorized) {
		t.Fatalf("expected injected SQL failure: %v", err)
	}
	var consumed sql.NullTime
	if err := db.QueryRow("SELECT consumed_at FROM wallet_user_challenges WHERE challenge_id = ?", challenge.ID).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	if consumed.Valid {
		t.Fatal("failed transaction consumed challenge")
	}
	if _, err := db.Exec("DROP TRIGGER " + trigger); err != nil {
		t.Fatal(err)
	}
	tokens, err := service.consumeChallenge(context.Background(), walletAuthProof(challenge))
	if err != nil {
		t.Fatalf("challenge retry after rollback: %v", err)
	}
	refreshTrigger := "wallet_refresh_rollback_" + suffix
	query = fmt.Sprintf("CREATE TRIGGER %s BEFORE INSERT ON wallet_user_refresh_tokens FOR EACH ROW BEGIN IF NEW.session_id = '%s' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test refresh insert failure'; END IF; END", refreshTrigger, tokens.Session.ID)
	if _, err := db.Exec(query); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP TRIGGER IF EXISTS " + refreshTrigger) })
	if _, err := service.rotateRefresh(context.Background(), tokens.RefreshToken); err == nil || errors.Is(err, errUserUnauthorized) {
		t.Fatalf("expected injected refresh SQL failure: %v", err)
	}
	if err := db.QueryRow("SELECT consumed_at FROM wallet_user_refresh_tokens WHERE token_hash = ?", userTokenHash(tokens.RefreshToken)).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	if consumed.Valid {
		t.Fatal("failed refresh consumed the original token")
	}
	if _, err := db.Exec("DROP TRIGGER " + refreshTrigger); err != nil {
		t.Fatal(err)
	}
	if _, err := service.rotateRefresh(context.Background(), tokens.RefreshToken); err != nil {
		t.Fatalf("refresh retry after rollback: %v", err)
	}
}

func TestMySQLWalletAuthHTTPBoundary(t *testing.T) {
	_, service, _, address := walletAuthIntegrationFixture(t)
	mux := http.NewServeMux()
	service.registerRoutes(mux)
	body, _ := json.Marshal(userChallengeInput{Address: address, ChainID: hoodiChainID, Origin: service.origin})
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, userAuthBridgeRequest(service, "/v1/user/auth/challenge", string(body)))
	if response.Code != 200 {
		t.Fatalf("challenge HTTP: %d %s", response.Code, response.Body.String())
	}
	var challenge userAuthChallenge
	if err := json.Unmarshal(response.Body.Bytes(), &challenge); err != nil {
		t.Fatal(err)
	}
	proof, _ := json.Marshal(walletAuthProof(&challenge))
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, userAuthBridgeRequest(service, "/v1/user/auth/verify", string(proof)))
	if response.Code != 200 {
		t.Fatalf("verify HTTP: %d %s", response.Code, response.Body.String())
	}
	var tokens userAuthTokens
	if err := json.Unmarshal(response.Body.Bytes(), &tokens); err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(map[string]string{"accessToken": tokens.AccessToken})
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, userAuthBridgeRequest(service, "/v1/user/auth/session", string(body)))
	if response.Code != 200 || !strings.Contains(response.Body.String(), address) {
		t.Fatalf("session HTTP: %d %s", response.Code, response.Body.String())
	}
	body, _ = json.Marshal(map[string]string{"refreshToken": tokens.RefreshToken})
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, userAuthBridgeRequest(service, "/v1/user/auth/logout", string(body)))
	if response.Code != 204 {
		t.Fatalf("logout HTTP: %d %s", response.Code, response.Body.String())
	}
}
