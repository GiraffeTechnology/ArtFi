package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const NFTTaskJournalPath = "/internal/v1/nft/operations"
const NFTTaskCapabilityMaxLifetime = 30 * time.Second

type NFTTaskPrincipal struct {
	Kind               string `json:"kind"`
	TaskID             string `json:"taskId"`
	TaskDigest         string `json:"taskDigest"`
	ExecutorDigest     string `json:"executorDigest"`
	GrantReference     string `json:"grantReference"`
	GrantPolicyVersion string `json:"grantPolicyVersion"`
	OperationID        string `json:"operationId"`
}
type NFTTaskCapabilityScope struct {
	PeerID            string `json:"peerId"`
	Action            string `json:"action"`
	NativeOperationID string `json:"nativeOperationId"`
	PlanDigest        string `json:"planDigest"`
	RequestDigest     string `json:"requestDigest"`
}
type NFTTaskCapability struct {
	NFTTaskCapabilityScope
	Principal   NFTTaskPrincipal `json:"principal"`
	Wallet      string           `json:"wallet"`
	ChainID     int              `json:"chainId"`
	IssuedAtMs  int64            `json:"issuedAtMs"`
	ExpiresAtMs int64            `json:"expiresAtMs"`
}

// These are server-composition interfaces, never populated from request JSON.
// AuthenticatePeer must authenticate the actual TLS/workload peer, not a header.
type NFTTaskPeerAuthenticator interface {
	AuthenticatePeer(*http.Request) (string, error)
}

// ConsumeCapability must atomically consume the short-lived capability while its
// existing grant gate is held. It must not reacquire that gate or extend a grant.
type NFTTaskCapabilityVerifier interface {
	ConsumeCapability(context.Context, string, NFTTaskCapabilityScope) (NFTTaskCapability, error)
}
type NFTTaskJournalConfig struct {
	DB                 *sql.DB
	PeerAuthenticator  NFTTaskPeerAuthenticator
	CapabilityVerifier NFTTaskCapabilityVerifier
	Now                func() time.Time
}
type nftTaskInput struct {
	Action    string       `json:"action"`
	Operation nftOperation `json:"operation"`
}

var nftTaskIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var nftTaskDigest = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
var nftTaskGrant = regexp.MustCompile(`^grant:[A-Za-z0-9_-]{1,122}$`)
var nftTaskVersion = regexp.MustCompile(`^[1-9][0-9]{0,77}$`)

func decodeNFTTaskPrincipal(raw []byte, target *NFTTaskPrincipal) error {
	if strictNFTJSON(raw, target) != nil || target.Kind != "task" || !nftTaskIdentifier.MatchString(target.TaskID) || !nftTaskIdentifier.MatchString(target.OperationID) || !nftTaskDigest.MatchString(target.TaskDigest) || !nftTaskDigest.MatchString(target.ExecutorDigest) || !nftTaskGrant.MatchString(target.GrantReference) || !nftTaskVersion.MatchString(target.GrantPolicyVersion) {
		return errUserForbidden
	}
	return nil
}
func strictNFTJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errUserForbidden
	}
	return nil
}

// Canonical wire digest: recursively sorted ASCII object keys, safe integer JSON
// numbers, and Go JSON string escaping (<, >, &, U+2028, U+2029). This is separate
// from the existing plan identity digest to preserve the session API contract.
func nftTaskWireDigest(raw []byte) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return "", errUserForbidden
	}
	var canonical func(any) (any, error)
	canonical = func(value any) (any, error) {
		switch v := value.(type) {
		case nil, string, bool:
			return v, nil
		case json.Number:
			n, err := v.Float64()
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || math.Abs(n) > 9007199254740991 {
				return nil, errUserForbidden
			}
			return n, nil
		case []any:
			for i, x := range v {
				c, err := canonical(x)
				if err != nil {
					return nil, err
				}
				v[i] = c
			}
			return v, nil
		case map[string]any:
			for key, x := range v {
				for _, char := range key {
					if char > 127 {
						return nil, errUserForbidden
					}
				}
				c, err := canonical(x)
				if err != nil {
					return nil, err
				}
				v[key] = c
			}
			return v, nil
		}
		return nil, errUserForbidden
	}
	value, err := canonical(value)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	// nftRequestDigest re-encodes JSON with the same Go canonical rules.
	return nftRequestDigest(encoded), nil
}

// NewNFTTaskJournalHandler is mounted only by the dedicated, explicit internal
// server composition. The ordinary NewHandler never registers this endpoint.
// Missing dependencies stay visibly unavailable rather than defaulting to trust.
func NewNFTTaskJournalHandler(config NFTTaskJournalConfig) http.Handler {
	now := config.Now
	if now == nil {
		now = time.Now
	}
	store := &nftOperationStore{db: config.DB, now: now}
	peer, verifier := config.PeerAuthenticator, config.CapabilityVerifier
	return newNFTTaskJournalHandler(store, peer, verifier, now, config.DB != nil)
}
func newNFTTaskJournalHandler(store *nftOperationStore, peer NFTTaskPeerAuthenticator, verifier NFTTaskCapabilityVerifier, now func() time.Time, configured bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		if r.URL.Path != NFTTaskJournalPath || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if !configured || peer == nil || verifier == nil || store == nil || store.db == nil || now == nil {
			writeUserAuthError(w, r, errUserAuthUnavailable)
			return
		}
		peerID, err := peer.AuthenticatePeer(r)
		if err != nil || peerID == "" {
			writeUserAuthError(w, r, errUserUnauthorized)
			return
		}
		authorization := r.Header.Get("Authorization")
		capability := strings.TrimPrefix(authorization, "Bearer ")
		if !strings.HasPrefix(authorization, "Bearer ") || len(capability) < 32 || len(capability) > 2048 || strings.ContainsAny(capability, " \t\r\n") {
			writeUserAuthError(w, r, errUserUnauthorized)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 65537))
		if err != nil || len(body) > 65536 {
			writeProblem(w, r, 413, "Invalid NFT record", "The record is too large.")
			return
		}
		var input nftTaskInput
		if strictNFTJSON(body, &input) != nil || !nftOperationID.MatchString(input.Operation.ID) || (input.Action != "get" && input.Action != "create" && input.Action != "update") {
			writeProblem(w, r, 400, "Invalid NFT record", "A valid operation is required.")
			return
		}
		requestDigest, err := nftTaskWireDigest(body)
		if err != nil {
			writeProblem(w, r, 400, "Invalid NFT record", "The record encoding is invalid.")
			return
		}
		planDigest := ""
		if input.Action != "get" {
			planDigest, err = nftTaskWireDigest(input.Operation.Plan)
			if err != nil {
				writeProblem(w, r, 422, "Invalid NFT plan", "An unsigned plan is required.")
				return
			}
		}
		scope := NFTTaskCapabilityScope{PeerID: peerID, Action: input.Action, NativeOperationID: input.Operation.ID, PlanDigest: planDigest, RequestDigest: requestDigest}
		claims, err := verifier.ConsumeCapability(r.Context(), capability, scope)
		if err != nil {
			writeUserAuthError(w, r, err)
			return
		}
		currentMs := now().UnixMilli()
		rawPrincipal, _ := json.Marshal(claims.Principal)
		if claims.NFTTaskCapabilityScope != scope || decodeNFTTaskPrincipal(rawPrincipal, &claims.Principal) != nil || !addressPattern.MatchString(claims.Wallet) || claims.ChainID <= 0 || claims.IssuedAtMs <= 0 || claims.IssuedAtMs > currentMs || claims.ExpiresAtMs <= currentMs || claims.ExpiresAtMs <= claims.IssuedAtMs || claims.ExpiresAtMs > claims.IssuedAtMs+NFTTaskCapabilityMaxLifetime.Milliseconds() {
			writeUserAuthError(w, r, errUserForbidden)
			return
		}
		principal := verifiedNFTPrincipal{wallet: claims.Wallet, chainID: claims.ChainID, task: &claims.Principal}
		operationContext, cancel := context.WithDeadline(r.Context(), time.UnixMilli(claims.ExpiresAtMs))
		defer cancel()
		operation, err := store.apply(operationContext, principal, input.Action, input.Operation)
		if err != nil {
			writeNFTStoreError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, operation)
	})
}
