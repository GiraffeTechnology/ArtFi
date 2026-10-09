package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var nftOperationID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,80}$`)
var nftDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type nftOperation struct {
	ID              string          `json:"id"`
	Wallet          string          `json:"wallet"`
	ChainID         int             `json:"chainId"`
	RequestHash     string          `json:"requestHash"`
	Revision        int             `json:"revision"`
	Status          string          `json:"status"`
	WalletStarted   bool            `json:"walletStarted"`
	Plan            json.RawMessage `json:"plan"`
	TransactionHash string          `json:"transactionHash,omitempty"`
	OrderHash       string          `json:"orderHash,omitempty"`
	UpdatedAt       string          `json:"updatedAt"`
}
type nftOperationInput struct {
	Action      string       `json:"action"`
	AccessToken string       `json:"accessToken"`
	Operation   nftOperation `json:"operation"`
}

func registerNFTOperations(mux *http.ServeMux, auth *userAuthService) {
	mux.HandleFunc("POST /v1/nft/operations", auth.nftOperations)
	mux.HandleFunc("POST /v1/nft/operations/history", auth.nftOperationHistory)
}

func validNFTTransition(from, to string) bool {
	if from == to {
		return true
	}
	switch from {
	case "awaiting-wallet":
		return to == "submitted" || to == "pending" || to == "cancelled" || to == "rejected" || to == "failed"
	case "submitted":
		return to == "accepted" || to == "pending" || to == "rejected"
	case "pending":
		return to == "confirmed" || to == "failed" || to == "cancelled" || to == "accepted"
	case "confirmed", "failed":
		return to == "pending" // A receipt reorg can invalidate success or failure.
	}
	return false
}

func nftPlanSafe(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			switch strings.ToLower(key) {
			case "signature", "privatekey", "seedphrase", "rawtransaction", "accesstoken", "apikey":
				return false
			}
			if !nftPlanSafe(child) {
				return false
			}
		}
	case []any:
		for _, child := range typed {
			if !nftPlanSafe(child) {
				return false
			}
		}
	}
	return true
}

func (service *userAuthService) nftOperations(writer http.ResponseWriter, request *http.Request) {
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
	body, err := io.ReadAll(io.LimitReader(request.Body, 65537))
	if err != nil || len(body) > 65536 {
		writeProblem(writer, request, 413, "Invalid NFT record", "The record is too large.")
		return
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	var input nftOperationInput
	if readUserAuthJSON(request, &input) != nil || !nftOperationID.MatchString(input.Operation.ID) {
		writeProblem(writer, request, 400, "Invalid NFT record", "A valid operation is required.")
		return
	}
	session, err := service.authenticate(request.Context(), input.AccessToken, false)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		service.writeError(writer, request, errUserAuthUnavailable)
		return
	}
	defer func() { _ = tx.Rollback() }()
	var current nftOperation
	var plan []byte
	var updated time.Time
	err = tx.QueryRowContext(request.Context(), `SELECT operation_id,wallet_address,chain_id,request_hash,revision,status,wallet_started,plan,COALESCE(transaction_hash,''),COALESCE(order_hash,''),updated_at FROM nft_operations WHERE operation_id=? FOR UPDATE`, input.Operation.ID).Scan(&current.ID, &current.Wallet, &current.ChainID, &current.RequestHash, &current.Revision, &current.Status, &current.WalletStarted, &plan, &current.TransactionHash, &current.OrderHash, &updated)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		service.writeError(writer, request, errUserAuthUnavailable)
		return
	}
	exists := err == nil
	if exists && (current.Wallet != session.Address || current.ChainID != session.ChainID) {
		service.writeError(writer, request, errUserForbidden)
		return
	}
	if input.Action == "get" {
		if !exists {
			writeProblem(writer, request, 404, "NFT record missing", "The operation was not found.")
			return
		}
		current.Plan = plan
		current.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		writeJSON(writer, 200, current)
		return
	}
	next := input.Operation
	if next.Wallet != session.Address || next.ChainID != session.ChainID || !nftDigest.MatchString(next.RequestHash) || (next.TransactionHash != "" && !txHashPattern.MatchString(next.TransactionHash)) || (next.OrderHash != "" && !txHashPattern.MatchString(next.OrderHash)) {
		writeProblem(writer, request, 422, "Invalid NFT binding", "The operation does not match the authenticated wallet and chain.")
		return
	}
	if input.Action == "create" && exists {
		if current.RequestHash != next.RequestHash {
			writeProblem(writer, request, 409, "Idempotency conflict", "The operation ID belongs to different terms.")
			return
		}
		current.Plan = plan
		current.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		writeJSON(writer, 200, current)
		return
	}
	var decoded map[string]any
	if json.Unmarshal(next.Plan, &decoded) != nil || !nftPlanSafe(decoded) || decoded["operationId"] != next.ID || (input.Action == "create" && decoded["sessionId"] != session.ID) || decoded["chainId"] != float64(session.ChainID) {
		writeProblem(writer, request, 422, "Invalid NFT plan", "Only the unsigned, session-bound wallet plan may be recorded.")
		return
	}
	now := service.now().UTC()
	if input.Action == "create" && !exists {
		if next.Status != "awaiting-wallet" || next.TransactionHash != "" || next.WalletStarted {
			writeProblem(writer, request, 409, "Invalid NFT state", "A new operation must await wallet approval.")
			return
		}
		next.Revision = 1
		_, err = tx.ExecContext(request.Context(), `INSERT INTO nft_operations(operation_id,wallet_address,chain_id,request_hash,revision,status,wallet_started,plan,transaction_hash,order_hash,created_at,updated_at) VALUES(?,?,?,?,1,?,FALSE,?,NULL,NULL,?,?)`, next.ID, next.Wallet, next.ChainID, next.RequestHash, next.Status, []byte(next.Plan), now, now)
	} else if input.Action == "update" && exists {
		if next.Revision != current.Revision || (current.WalletStarted && !next.WalletStarted) || next.RequestHash != current.RequestHash || !validNFTTransition(current.Status, next.Status) || nftRequestDigest(next.Plan) != nftRequestDigest(plan) || (current.TransactionHash != "" && next.TransactionHash != current.TransactionHash) || (current.OrderHash != "" && next.OrderHash != current.OrderHash) {
			writeProblem(writer, request, 409, "NFT state conflict", "Refresh this operation before continuing.")
			return
		}
		next.Revision++
		_, err = tx.ExecContext(request.Context(), `UPDATE nft_operations SET revision=?,status=?,wallet_started=?,transaction_hash=NULLIF(?,''),order_hash=NULLIF(?,''),updated_at=? WHERE operation_id=?`, next.Revision, next.Status, next.WalletStarted, next.TransactionHash, next.OrderHash, now, next.ID)
	} else {
		writeProblem(writer, request, 409, "NFT state conflict", "The requested operation transition is unavailable.")
		return
	}
	if err != nil || tx.Commit() != nil {
		service.writeError(writer, request, errUserAuthUnavailable)
		return
	}
	next.UpdatedAt = now.Format(time.RFC3339Nano)
	writeJSON(writer, 200, next)
}

func nftRequestDigest(value []byte) string {
	var data any
	if json.Unmarshal(value, &data) != nil {
		return ""
	}
	canonical, _ := json.Marshal(data)
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:])
}
