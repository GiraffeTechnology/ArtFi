package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	userChallengeLifetime = 5 * time.Minute
	userAccessLifetime    = 10 * time.Minute
	userSessionLifetime   = 30 * 24 * time.Hour
	userJWTIssuer         = "artfi-user-auth"
	userJWTAudience       = "artfi-web"
)

var (
	errUserUnauthorized    = errors.New("wallet session is invalid or expired")
	errUserForbidden       = errors.New("wallet session does not match seller or chain")
	errUserAuthUnavailable = errors.New("persistent wallet authentication is unavailable")
)

// userAuthService deliberately has no in-memory persistence fallback. Every accepted
// access token is checked against the durable session record, including revocation.
type userAuthService struct {
	db          persistenceDB
	jwtSecret   []byte
	bridgeToken []byte
	origin      string
	now         func() time.Time
}

type userAuthChallenge struct {
	ID        string `json:"id"`
	Address   string `json:"address"`
	ChainID   int    `json:"chainId"`
	Origin    string `json:"origin"`
	Message   string `json:"message"`
	IssuedAt  int64  `json:"issuedAt"`
	ExpiresAt int64  `json:"expiresAt"`
	nonce     string
}

type userAuthSession struct {
	ID              string `json:"id"`
	Address         string `json:"address"`
	ChainID         int    `json:"chainId"`
	ExpiresAt       int64  `json:"expiresAt"`
	AccessExpiresAt int64  `json:"accessExpiresAt"`
	origin          string
	createdAt       time.Time
	revoked         bool
}

type userAuthTokens struct {
	Session      userAuthSession `json:"session"`
	AccessToken  string          `json:"accessToken"`
	RefreshToken string          `json:"refreshToken"`
}

type userAccessClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	SessionID string `json:"sid"`
	ChainID   int    `json:"chainId"`
	Origin    string `json:"origin"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

type userChallengeInput struct {
	Address string `json:"address"`
	ChainID int    `json:"chainId"`
	Origin  string `json:"origin"`
}

type userVerifyInput struct {
	ChallengeID string `json:"challengeId"`
	Address     string `json:"address"`
	ChainID     int    `json:"chainId"`
	Origin      string `json:"origin"`
	Message     string `json:"message"`
}

// registerUserAuthRoutes returns the same verifier used by the native signed-order
// POST guard. Register it once when constructing the handler.
func registerUserAuthRoutes(mux *http.ServeMux, rwa *rwaService) *userAuthService {
	service := &userAuthService{
		db: rwa.db, now: rwa.now,
		jwtSecret:   []byte(os.Getenv("ARTFI_USER_SESSION_SECRET")),
		bridgeToken: []byte(os.Getenv("ARTFI_USER_AUTH_BRIDGE_TOKEN")),
		origin:      strings.TrimSpace(os.Getenv("ARTFI_WEB_ORIGIN")),
	}
	service.registerRoutes(mux)
	return service
}

func (service *userAuthService) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/user/auth/challenge", service.trustedBridge(service.challenge))
	mux.HandleFunc("POST /v1/user/auth/verify", service.trustedBridge(service.verify))
	mux.HandleFunc("POST /v1/user/auth/session", service.trustedBridge(service.session))
	mux.HandleFunc("POST /v1/user/auth/refresh", service.trustedBridge(service.refresh))
	mux.HandleFunc("POST /v1/user/auth/logout", service.trustedBridge(service.logout))
}

func (service *userAuthService) available() bool {
	parsed, err := url.Parse(service.origin)
	validOrigin := err == nil && parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && parsed.Path == "" &&
		(parsed.Scheme == "https" || (parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")))
	return service.db != nil && service.now != nil && validOrigin && len(service.jwtSecret) >= 32 && len(service.bridgeToken) >= 32 && !hmac.Equal(service.jwtSecret, service.bridgeToken)
}

// The bridge attests that the BFF verified the exact challenge message using the
// wallet's EOA signature or its EIP-1271 implementation on the configured chain.
// Its dedicated server credential grants no operator or indexer authority.
func (service *userAuthService) trustedBridge(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		if !service.available() {
			service.writeError(writer, request, errUserAuthUnavailable)
			return
		}
		authorization := request.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") || !hmac.Equal([]byte(strings.TrimPrefix(authorization, "Bearer ")), service.bridgeToken) {
			service.writeError(writer, request, errUserUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, 8193))
		if err != nil || len(body) > 8192 || request.URL.RawQuery != "" {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid authentication request", "The request body is invalid or too large.")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		next(writer, request)
	}
}

func readUserAuthJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (service *userAuthService) challenge(writer http.ResponseWriter, request *http.Request) {
	var input userChallengeInput
	if err := readUserAuthJSON(request, &input); err != nil || !addressPattern.MatchString(input.Address) || input.ChainID != hoodiChainID || input.Origin != service.origin {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid wallet challenge", "A wallet address, Hoodi chain, and configured web origin are required.")
		return
	}
	challenge, err := service.createChallenge(request.Context(), input)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, challenge)
}

func (service *userAuthService) createChallenge(ctx context.Context, input userChallengeInput) (*userAuthChallenge, error) {
	id, err := userRandomToken(16)
	if err != nil {
		return nil, err
	}
	nonce, err := userRandomToken(32)
	if err != nil {
		return nil, err
	}
	now := service.now().UTC().Truncate(time.Second)
	challenge := &userAuthChallenge{ID: id, Address: strings.ToLower(input.Address), ChainID: input.ChainID, Origin: input.Origin, IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(userChallengeLifetime).UnixMilli(), nonce: nonce}
	challenge.Message = userChallengeMessage(challenge)
	if err := service.persistUserChallenge(ctx, challenge); err != nil {
		return nil, err
	}
	return challenge, nil
}

func userChallengeMessage(challenge *userAuthChallenge) string {
	origin, _ := url.Parse(challenge.Origin)
	return fmt.Sprintf("%s wants you to sign in with your Ethereum account:\n%s\n\nSign in to ArtFi. This request does not authorize a blockchain transaction.\n\nURI: %s\nVersion: 1\nChain ID: %d\nNonce: %s\nIssued At: %s\nExpiration Time: %s", origin.Host, challenge.Address, challenge.Origin, challenge.ChainID, challenge.nonce, time.UnixMilli(challenge.IssuedAt).UTC().Format(time.RFC3339), time.UnixMilli(challenge.ExpiresAt).UTC().Format(time.RFC3339))
}

func (service *userAuthService) verify(writer http.ResponseWriter, request *http.Request) {
	var input userVerifyInput
	if err := readUserAuthJSON(request, &input); err != nil || !addressPattern.MatchString(input.Address) || input.Origin != service.origin || input.ChainID != hoodiChainID {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	input.Address = strings.ToLower(input.Address)
	result, err := service.consumeChallenge(request.Context(), input)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

func (service *userAuthService) session(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		AccessToken string `json:"accessToken"`
	}
	if err := readUserAuthJSON(request, &input); err != nil {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	session, err := service.authenticate(request.Context(), input.AccessToken, false)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"session": session})
}

func (service *userAuthService) refresh(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := readUserAuthJSON(request, &input); err != nil || !validUserRefreshToken(input.RefreshToken) {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	tokens, err := service.rotateRefresh(request.Context(), input.RefreshToken)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, tokens)
}

func (service *userAuthService) logout(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		RefreshToken string `json:"refreshToken"`
		AccessToken  string `json:"accessToken"`
	}
	if err := readUserAuthJSON(request, &input); err != nil {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	var sessionID string
	if input.AccessToken != "" {
		claims, err := service.parseAccess(input.AccessToken, true)
		if err == nil {
			sessionID = claims.SessionID
		}
	}
	if sessionID == "" && !validUserRefreshToken(input.RefreshToken) {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	if err := service.revokeUserSession(request.Context(), sessionID, input.RefreshToken); err != nil {
		service.writeError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

// requireSeller is only for the native signed-order POST endpoint. It must not be
// attached to public catalog reads or to unrelated operator/indexer APIs.
func (service *userAuthService) requireSeller(request *http.Request, seller string, chainID int) error {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || strings.TrimPrefix(authorization, "Bearer ") == "" {
		return errUserUnauthorized
	}
	if !service.available() {
		return errUserAuthUnavailable
	}
	session, err := service.authenticate(request.Context(), strings.TrimPrefix(authorization, "Bearer "), false)
	if err != nil {
		return err
	}
	if !addressPattern.MatchString(seller) || !strings.EqualFold(session.Address, seller) || session.ChainID != chainID {
		return errUserForbidden
	}
	return nil
}

func (service *userAuthService) authenticate(ctx context.Context, token string, allowExpired bool) (*userAuthSession, error) {
	if !service.available() {
		return nil, errUserAuthUnavailable
	}
	claims, err := service.parseAccess(token, allowExpired)
	if err != nil {
		return nil, err
	}
	session, err := service.loadUserSession(ctx, claims.SessionID)
	if err != nil {
		return nil, err
	}
	if session.revoked || session.ExpiresAt <= service.now().UnixMilli() || session.Address != claims.Subject || session.ChainID != claims.ChainID || session.origin != claims.Origin || claims.IssuedAt < session.createdAt.Unix() || claims.ExpiresAt > session.ExpiresAt/1000 {
		return nil, errUserUnauthorized
	}
	session.AccessExpiresAt = claims.ExpiresAt * 1000
	return session, nil
}

func (service *userAuthService) issueAccess(session userAuthSession) (string, int64, error) {
	now := service.now().Unix()
	expires := min(now+int64(userAccessLifetime/time.Second), session.ExpiresAt/1000)
	claims := userAccessClaims{Issuer: userJWTIssuer, Audience: userJWTAudience, Subject: session.Address, SessionID: session.ID, ChainID: session.ChainID, Origin: session.origin, IssuedAt: now, ExpiresAt: expires}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", 0, err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, service.jwtSecret)
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), expires * 1000, nil
}

func (service *userAuthService) parseAccess(token string, allowExpired bool) (*userAccessClaims, error) {
	if len(token) > 4096 {
		return nil, errUserUnauthorized
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errUserUnauthorized
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(header) != `{"alg":"HS256","typ":"JWT"}` {
		return nil, errUserUnauthorized
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	mac := hmac.New(sha256.New, service.jwtSecret)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, errUserUnauthorized
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errUserUnauthorized
	}
	var claims userAccessClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return nil, errUserUnauthorized
	}
	now := service.now().Unix()
	if claims.Issuer != userJWTIssuer || claims.Audience != userJWTAudience || !addressPattern.MatchString(claims.Subject) || claims.Subject != strings.ToLower(claims.Subject) || len(claims.SessionID) != 32 || claims.ChainID != hoodiChainID || claims.Origin != service.origin || claims.IssuedAt > now || claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > int64(userAccessLifetime/time.Second) || (!allowExpired && claims.ExpiresAt <= now) {
		return nil, errUserUnauthorized
	}
	return &claims, nil
}

func (service *userAuthService) writeError(writer http.ResponseWriter, request *http.Request, err error) {
	writeUserAuthError(writer, request, err)
}

func writeUserAuthError(writer http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, errUserForbidden) {
		writeProblem(writer, request, http.StatusForbidden, "Wallet does not match seller", "Use the signed-order seller wallet on the matching chain.")
		return
	}
	if errors.Is(err, errUserUnauthorized) {
		writeProblem(writer, request, http.StatusUnauthorized, "Wallet authentication failed", "Sign in again with the wallet for this action.")
		return
	}
	writeProblem(writer, request, http.StatusServiceUnavailable, "Wallet authentication unavailable", "Persistent wallet authentication is temporarily unavailable.")
}

func userRandomToken(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func validUserRefreshToken(token string) bool {
	if len(token) != 64 {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil && token == strings.ToLower(token)
}

func userTokenHash(token string) []byte { hash := sha256.Sum256([]byte(token)); return hash[:] }
