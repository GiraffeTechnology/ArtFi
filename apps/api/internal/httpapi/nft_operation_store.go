package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// The constructors remain inside this package: a request body cannot instantiate
// authority. Session and authenticated task handlers share this exact repository.
type verifiedNFTPrincipal struct {
	wallet    string
	chainID   int
	sessionID string
	task      *NFTTaskPrincipal
}
type nftOperationStore struct {
	db  persistenceDB
	now func() time.Time
}
type nftStoreError struct {
	status        int
	title, detail string
}

func (e *nftStoreError) Error() string { return e.title }
func nftStoreProblem(status int, title, detail string) error {
	return &nftStoreError{status, title, detail}
}
func writeNFTStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var problem *nftStoreError
	if errors.As(err, &problem) {
		writeProblem(w, r, problem.status, problem.title, problem.detail)
		return
	}
	writeUserAuthError(w, r, err)
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
			normalized := strings.Map(func(r rune) rune {
				if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
					return r
				}
				return -1
			}, strings.ToLower(key))
			if strings.Contains(normalized, "signature") {
				return false
			}
			switch normalized {
			case "signature", "exactsignature", "privatekey", "seedphrase", "mnemonic", "rawtransaction", "signedtransaction", "rawsignedtransaction", "signedrawtransaction", "accesstoken", "refreshtoken", "apikey", "authorization", "capability", "password", "secret":
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

func (p verifiedNFTPrincipal) owns(operation nftOperation) bool {
	if operation.ChainID != p.chainID {
		return false
	}
	if p.task == nil {
		if operation.Wallet != p.wallet {
			return false
		}
	} else if !strings.EqualFold(operation.Wallet, p.wallet) {
		return false
	}
	var plan map[string]json.RawMessage
	if json.Unmarshal(operation.Plan, &plan) != nil {
		return false
	}
	if p.task == nil {
		// Preserve session refresh behavior: a later verified session for the same
		// wallet can recover its original session record, but cannot adopt a task row.
		_, hasTask := plan["taskPrincipal"]
		return !hasTask
	}
	if _, hasSession := plan["sessionId"]; hasSession {
		return false
	}
	var principal NFTTaskPrincipal
	return decodeNFTTaskPrincipal(plan["taskPrincipal"], &principal) == nil && principal == *p.task
}

// decideNFTMutation is shared by the SQL repository and synthetic state-machine
// tests. Its boolean means a durable write is needed, never authorization.
func decideNFTMutation(p verifiedNFTPrincipal, action string, next nftOperation, current *nftOperation, now time.Time) (nftOperation, bool, error) {
	conflict := func() (nftOperation, bool, error) {
		return nftOperation{}, false, nftStoreProblem(409, "NFT state conflict", "Refresh this operation before continuing.")
	}
	if !nftOperationID.MatchString(next.ID) {
		return nftOperation{}, false, nftStoreProblem(400, "Invalid NFT record", "A valid operation is required.")
	}
	if current != nil && !p.owns(*current) {
		return nftOperation{}, false, errUserForbidden
	}
	if action == "get" {
		if current == nil {
			return nftOperation{}, false, nftStoreProblem(404, "NFT record missing", "The operation was not found.")
		}
		return *current, false, nil
	}
	walletMatches := next.Wallet == p.wallet
	if p.task != nil {
		walletMatches = strings.EqualFold(next.Wallet, p.wallet)
	}
	if !walletMatches || next.ChainID != p.chainID || !nftDigest.MatchString(next.RequestHash) || (next.TransactionHash != "" && !txHashPattern.MatchString(next.TransactionHash)) || (next.OrderHash != "" && !txHashPattern.MatchString(next.OrderHash)) {
		return nftOperation{}, false, nftStoreProblem(422, "Invalid NFT binding", "The operation does not match the authenticated wallet and chain.")
	}
	if action == "create" && current != nil && p.task == nil {
		if current.RequestHash != next.RequestHash {
			return nftOperation{}, false, nftStoreProblem(409, "Idempotency conflict", "The operation ID belongs to different terms.")
		}
		return *current, false, nil
	}
	var decoded map[string]any
	if json.Unmarshal(next.Plan, &decoded) != nil || decoded == nil || !nftPlanSafe(decoded) || decoded["operationId"] != next.ID || decoded["chainId"] != float64(p.chainID) || !p.owns(next) {
		return nftOperation{}, false, nftStoreProblem(422, "Invalid NFT plan", "Only an unsigned, authenticated-principal-bound wallet plan may be recorded.")
	}
	if p.task != nil {
		request, ok := decoded["request"].(map[string]any)
		account, accountOK := request["account"].(string)
		planID, planOK := decoded["id"].(string)
		if !ok || !accountOK || !strings.EqualFold(account, p.wallet) || !planOK || !nftTaskIdentifier.MatchString(planID) {
			return nftOperation{}, false, nftStoreProblem(422, "Invalid NFT plan", "The unsigned plan must retain its native plan ID and authenticated account.")
		}
	}
	if p.task == nil && action == "create" && decoded["sessionId"] != p.sessionID {
		return nftOperation{}, false, nftStoreProblem(422, "Invalid NFT plan", "Only the unsigned, session-bound wallet plan may be recorded.")
	}
	if action == "create" && current != nil {
		if current.RequestHash != next.RequestHash || nftRequestDigest(current.Plan) != nftRequestDigest(next.Plan) {
			return conflict()
		}
		return *current, false, nil
	}
	if action == "create" && current == nil {
		if next.Status != "awaiting-wallet" || next.TransactionHash != "" || next.WalletStarted || (p.task != nil && next.OrderHash != "") {
			return conflict()
		}
		next.Revision = 1
	} else if action == "update" && current != nil {
		if next.Revision != current.Revision || (current.WalletStarted && !next.WalletStarted) || next.RequestHash != current.RequestHash || !validNFTTransition(current.Status, next.Status) || nftRequestDigest(next.Plan) != nftRequestDigest(current.Plan) || (current.TransactionHash != "" && next.TransactionHash != current.TransactionHash) || (current.OrderHash != "" && next.OrderHash != current.OrderHash) {
			return conflict()
		}
		next.Revision++
	} else {
		return conflict()
	}
	next.UpdatedAt = now.UTC().Format(time.RFC3339Nano)
	return next, true, nil
}

func (store *nftOperationStore) apply(ctx context.Context, principal verifiedNFTPrincipal, action string, input nftOperation) (nftOperation, error) {
	if store == nil || store.db == nil || store.now == nil {
		return nftOperation{}, errUserAuthUnavailable
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nftOperation{}, errUserAuthUnavailable
	}
	defer func() { _ = tx.Rollback() }()
	var current nftOperation
	var plan []byte
	var updated time.Time
	err = tx.QueryRowContext(ctx, `SELECT operation_id,wallet_address,chain_id,request_hash,revision,status,wallet_started,plan,COALESCE(transaction_hash,''),COALESCE(order_hash,''),updated_at FROM nft_operations WHERE operation_id=? FOR UPDATE`, input.ID).Scan(&current.ID, &current.Wallet, &current.ChainID, &current.RequestHash, &current.Revision, &current.Status, &current.WalletStarted, &plan, &current.TransactionHash, &current.OrderHash, &updated)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nftOperation{}, errUserAuthUnavailable
	}
	var previous *nftOperation
	if err == nil {
		current.Plan = plan
		current.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		previous = &current
	}
	now := store.now().UTC()
	next, write, err := decideNFTMutation(principal, action, input, previous, now)
	if err != nil || !write {
		return next, err
	}
	if previous == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO nft_operations(operation_id,wallet_address,chain_id,request_hash,revision,status,wallet_started,plan,transaction_hash,order_hash,created_at,updated_at) VALUES(?,?,?,?,1,?,FALSE,?,NULL,NULL,?,?)`, next.ID, next.Wallet, next.ChainID, next.RequestHash, next.Status, []byte(next.Plan), now, now)
	} else {
		// The row lock and revision predicate both protect CAS across processes.
		var result sql.Result
		result, err = tx.ExecContext(ctx, `UPDATE nft_operations SET revision=?,status=?,wallet_started=?,transaction_hash=NULLIF(?,''),order_hash=NULLIF(?,''),updated_at=? WHERE operation_id=? AND revision=?`, next.Revision, next.Status, next.WalletStarted, next.TransactionHash, next.OrderHash, now, next.ID, previous.Revision)
		if err == nil {
			count, countErr := result.RowsAffected()
			if countErr != nil || count != 1 {
				return nftOperation{}, nftStoreProblem(409, "NFT state conflict", "Refresh this operation before continuing.")
			}
		}
	}
	if err != nil || tx.Commit() != nil {
		return nftOperation{}, errUserAuthUnavailable
	}
	return next, nil
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
