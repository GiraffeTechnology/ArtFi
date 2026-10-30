package httpapi

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// This records the SQL contract only. It is not a database or concurrency proof.
type holderChallengeDBSpy struct {
	query  string
	args   []any
	calls  int
	result sql.Result
	err    error
}

func (s *holderChallengeDBSpy) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	s.calls++
	s.query = query
	s.args = args
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return s.result, s.err
}
func (*holderChallengeDBSpy) BeginTx(context.Context, *sql.TxOptions) (*sql.Tx, error) {
	return nil, errors.New("not used by single statement")
}
func (*holderChallengeDBSpy) QueryContext(context.Context, string, ...any) (*sql.Rows, error) {
	return nil, errors.New("not used by single statement")
}

type holderChallengeResult struct {
	count int64
	err   error
}

func (s holderChallengeResult) RowsAffected() (int64, error) { return s.count, s.err }
func (holderChallengeResult) LastInsertId() (int64, error)   { return 0, nil }
func holderChallengeFixture() (*userAuthService, *holderChallengeDBSpy, charityHolderChallengeInput) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	db := &holderChallengeDBSpy{result: holderChallengeResult{count: 1}}
	service := &userAuthService{db: db, now: func() time.Time { return now }, origin: "https://artfi.test", jwtSecret: []byte(strings.Repeat("synthetic-jwt-", 4)), bridgeToken: []byte(strings.Repeat("synthetic-bridge-", 4))}
	return service, db, charityHolderChallengeInput{ChallengeHash: strings.Repeat("a", 64), Address: "0x1111111111111111111111111111111111111111", ChainID: hoodiChainID, TokenID: "7", Origin: service.origin, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(5 * time.Minute).UnixMilli()}
}
func holderChallengeCall(service *userAuthService, action string, body []byte, credential string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	service.registerRoutes(mux)
	req := httptest.NewRequest("POST", "/v1/user/auth/"+action, strings.NewReader(string(body)))
	req.Header.Set("Authorization", credential)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	return out
}
func TestCharityHolderDurableRegistrationSQLContract(t *testing.T) {
	service, db, input := holderChallengeFixture()
	body, _ := json.Marshal(input)
	out := holderChallengeCall(service, "holder-challenge", body, "Bearer "+string(service.bridgeToken))
	if out.Code != 204 || out.Header().Get("Cache-Control") != "no-store" || db.calls != 1 {
		t.Fatalf("register status=%d calls=%d", out.Code, db.calls)
	}
	if !strings.Contains(db.query, "INSERT INTO charity_holder_challenges") || strings.Contains(strings.ToUpper(db.query), "UPDATE") || len(db.args) != 7 {
		t.Fatal("not a fresh immutable registration")
	}
	hash, _ := hex.DecodeString(input.ChallengeHash)
	if string(db.args[0].([]byte)) != string(hash) || db.args[1] != input.Address || db.args[2] != input.ChainID || db.args[3] != input.TokenID || db.args[4] != input.Origin || !db.args[5].(time.Time).Equal(time.UnixMilli(input.IssuedAt)) || !db.args[6].(time.Time).Equal(time.UnixMilli(input.ExpiresAt)) {
		t.Fatal("registration binding differs")
	}
}
func TestCharityHolderDurableConsumptionSQLContract(t *testing.T) {
	service, db, input := holderChallengeFixture()
	body, _ := json.Marshal(input)
	out := holderChallengeCall(service, "holder-consume", body, "Bearer "+string(service.bridgeToken))
	if out.Code != 204 || db.calls != 1 || len(db.args) != 10 {
		t.Fatalf("consume status=%d calls=%d args=%d", out.Code, db.calls, len(db.args))
	}
	for _, part := range []string{"UPDATE charity_holder_challenges SET consumed_at = ?", "challenge_hash = ? AND wallet_address = ? AND chain_id = ? AND token_id = ? AND origin = ?", "issued_at = ? AND expires_at = ? AND consumed_at IS NULL AND issued_at <= ? AND expires_at > ?"} {
		if !strings.Contains(db.query, part) {
			t.Fatalf("missing SQL guard: %s", part)
		}
	}
	if db.args[2] != input.Address || db.args[3] != input.ChainID || db.args[4] != input.TokenID || db.args[5] != input.Origin || db.args[0] != db.args[8] || db.args[8] != db.args[9] {
		t.Fatal("CAS scope/time differs")
	}
}
func TestCharityHolderDurableInputScope(t *testing.T) {
	cases := []struct {
		name   string
		change func(*charityHolderChallengeInput)
	}{{"hash length", func(x *charityHolderChallengeInput) { x.ChallengeHash = "a" }}, {"hash case", func(x *charityHolderChallengeInput) { x.ChallengeHash = strings.Repeat("A", 64) }}, {"hash invalid", func(x *charityHolderChallengeInput) { x.ChallengeHash = strings.Repeat("z", 64) }}, {"wallet", func(x *charityHolderChallengeInput) { x.Address = "invalid" }}, {"chain", func(x *charityHolderChallengeInput) { x.ChainID = 1 }}, {"origin", func(x *charityHolderChallengeInput) { x.Origin = "https://other.test" }}, {"token zero", func(x *charityHolderChallengeInput) { x.TokenID = "0" }}, {"token alias", func(x *charityHolderChallengeInput) { x.TokenID = "007" }}, {"token sign", func(x *charityHolderChallengeInput) { x.TokenID = "+7" }}, {"token overflow", func(x *charityHolderChallengeInput) { x.TokenID = strings.Repeat("9", 78) }}, {"expiry", func(x *charityHolderChallengeInput) { x.IssuedAt -= 300000; x.ExpiresAt -= 300000 }}, {"ttl", func(x *charityHolderChallengeInput) { x.ExpiresAt++ }}, {"future issue", func(x *charityHolderChallengeInput) { x.IssuedAt += 6000; x.ExpiresAt += 6000 }}}
	for _, tc := range cases {
		for _, action := range []string{"holder-challenge", "holder-consume"} {
			t.Run(tc.name+"/"+action, func(t *testing.T) {
				service, db, input := holderChallengeFixture()
				tc.change(&input)
				body, _ := json.Marshal(input)
				out := holderChallengeCall(service, action, body, "Bearer "+string(service.bridgeToken))
				if out.Code != 401 || db.calls != 0 {
					t.Fatalf("invalid scope status=%d writes=%d", out.Code, db.calls)
				}
			})
		}
	}
}
func TestCharityHolderDurableRequiresOriginalBridge(t *testing.T) {
	for _, action := range []string{"holder-challenge", "holder-consume"} {
		for _, credential := range []string{"", "Bearer browser", "Bearer operator", "Bearer " + strings.Repeat("synthetic-jwt-", 4)} {
			t.Run(action+"/"+credential, func(t *testing.T) {
				service, db, input := holderChallengeFixture()
				body, _ := json.Marshal(input)
				out := holderChallengeCall(service, action, body, credential)
				if out.Code != 401 || db.calls != 0 {
					t.Fatalf("untrusted status=%d writes=%d", out.Code, db.calls)
				}
			})
		}
	}
}
func TestCharityHolderDurableRejectsUnknownAndTrailingJSON(t *testing.T) {
	for _, suffix := range []string{`,"unknown":true}`, `} {}`} {
		service, db, input := holderChallengeFixture()
		body, _ := json.Marshal(input)
		body = append(body[:len(body)-1], []byte(suffix)...)
		out := holderChallengeCall(service, "holder-consume", body, "Bearer "+string(service.bridgeToken))
		if out.Code != 401 || db.calls != 0 {
			t.Fatalf("invalid JSON status=%d writes=%d", out.Code, db.calls)
		}
	}
}
func TestCharityHolderDurableStoreFailuresDoNotFallback(t *testing.T) {
	for _, action := range []string{"holder-challenge", "holder-consume"} {
		cases := []struct {
			name   string
			result sql.Result
			err    error
			status int
		}{{"already consumed or mismatched", holderChallengeResult{count: 0}, nil, 401}, {"unexpected multiple rows", holderChallengeResult{count: 2}, nil, 401}, {"SQL write failure", nil, errors.New("private database failure"), 503}, {"uncertain result", holderChallengeResult{err: errors.New("private result failure")}, nil, 503}}
		for _, tc := range cases {
			t.Run(action+"/"+tc.name, func(t *testing.T) {
				service, db, input := holderChallengeFixture()
				db.result, db.err = tc.result, tc.err
				body, _ := json.Marshal(input)
				out := holderChallengeCall(service, action, body, "Bearer "+string(service.bridgeToken))
				if out.Code != tc.status || db.calls != 1 || strings.Contains(out.Body.String(), "private") {
					t.Fatalf("store status=%d calls=%d body=%s", out.Code, db.calls, out.Body.String())
				}
			})
		}
	}
}
func TestCharityHolderDurableUnavailableStore(t *testing.T) {
	service, db, input := holderChallengeFixture()
	service.db = nil
	body, _ := json.Marshal(input)
	out := holderChallengeCall(service, "holder-consume", body, "Bearer "+string(service.bridgeToken))
	if out.Code != 503 || db.calls != 0 {
		t.Fatal("missing store did not close")
	}
}
func TestCharityHolderDurableCancelledContext(t *testing.T) {
	service, db, input := holderChallengeFixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.consumeHolderChallengeRecord(ctx, input); !errors.Is(err, context.Canceled) || db.calls != 1 {
		t.Fatalf("cancelled write: %v", err)
	}
}
