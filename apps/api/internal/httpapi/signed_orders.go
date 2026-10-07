package httpapi

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// These are public sale authorizations, never raw signed transactions or custody records.
type signedOrder struct {
	Kind          string                     `json:"kind"`
	ChainID       int                        `json:"chainId"`
	MarketAddress string                     `json:"marketAddress"`
	IntentHash    string                     `json:"intentHash"`
	Intent        map[string]json.RawMessage `json:"intent"`
	Signature     string                     `json:"signature"`
	CreatedAt     string                     `json:"createdAt,omitempty"`
}

var canonicalOrderUint = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
var orderSignaturePattern = regexp.MustCompile(`^0x(?:[0-9a-fA-F]{2})*$`)
var errSignedOrderConflict = errors.New("the stored authorization has different immutable terms or signature")

func orderString(fields map[string]json.RawMessage, name string) string {
	var value string
	_ = json.Unmarshal(fields[name], &value)
	return value
}
func canonicalUint256(value string) bool {
	n, ok := new(big.Int).SetString(value, 10)
	return ok && canonicalOrderUint.MatchString(value) && n.BitLen() <= 256
}
func normalizeSignedOrder(input signedOrder) (signedOrder, error) {
	invalid := func() (signedOrder, error) {
		return signedOrder{}, errors.New("the order must contain the exact supported sale fields, deployment and bounded canonical values")
	}
	if input.ChainID != hoodiChainID || (input.Kind != "whole" && input.Kind != "fraction") || !addressPattern.MatchString(input.MarketAddress) || !txHashPattern.MatchString(input.IntentHash) || len(input.Signature) > 16386 || !orderSignaturePattern.MatchString(input.Signature) || input.CreatedAt != "" {
		return invalid()
	}
	addressFields := []string{"seller", "paymentToken", "buyer"}
	uintFields := []string{"salt", "epoch"}
	if input.Kind == "whole" {
		addressFields = append(addressFields, "collection")
		uintFields = append(uintFields, "tokenId", "price")
	} else {
		addressFields = append(addressFields, "assetToken")
		uintFields = append(uintFields, "maxAmount", "unitPrice")
	}
	if len(input.Intent) != len(addressFields)+len(uintFields)+2 {
		return invalid()
	}
	normalized := make(map[string]json.RawMessage, len(input.Intent))
	for _, name := range addressFields {
		value := orderString(input.Intent, name)
		if !addressPattern.MatchString(value) {
			return invalid()
		}
		normalized[name], _ = json.Marshal(strings.ToLower(value))
	}
	for _, name := range uintFields {
		value := orderString(input.Intent, name)
		if !canonicalUint256(value) {
			return invalid()
		}
		normalized[name], _ = json.Marshal(value)
	}
	for _, name := range []string{"startsAt", "endsAt"} {
		raw := input.Intent[name]
		var value uint64
		if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || value > (1<<48)-1 {
			return invalid()
		}
		normalized[name], _ = json.Marshal(value)
	}
	input.Intent = normalized
	input.MarketAddress = strings.ToLower(input.MarketAddress)
	input.IntentHash = strings.ToLower(input.IntentHash)
	// Hex letter case does not change the original signature bytes.
	input.Signature = strings.ToLower(input.Signature)
	return input, nil
}

func decodeSignedOrder(request *http.Request) (signedOrder, error) {
	raw, err := io.ReadAll(io.LimitReader(request.Body, 32769))
	if err != nil {
		return signedOrder{}, err
	}
	if len(raw) > 32768 {
		return signedOrder{}, errors.New("the order exceeds 32 KiB")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return signedOrder{}, err
	}
	if len(fields) != 6 {
		return signedOrder{}, errors.New("the exact six order envelope fields are required")
	}
	for _, key := range []string{"kind", "chainId", "marketAddress", "intentHash", "intent", "signature"} {
		if _, ok := fields[key]; !ok {
			return signedOrder{}, errors.New("the exact order envelope fields are required")
		}
	}
	var input signedOrder
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&input); err != nil {
		return input, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return input, errors.New("exactly one JSON object is required")
	}
	return normalizeSignedOrder(input)
}

// Only the existing server verifier can admit a sale signature; the independent
// user session must also belong to its seller. Public reads need neither secret.
func (service *rwaService) ingestSignedOrder(writer http.ResponseWriter, request *http.Request, auth *userAuthService) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, 503, "Order storage unavailable", "Durable persistence and the configured verifier are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, 401, "Verifier authentication failed", "A valid internal verifier credential is required.")
		return
	}
	input, err := decodeSignedOrder(request)
	if err != nil {
		writeProblem(writer, request, 400, "Invalid signed order", err.Error())
		return
	}
	if err = auth.requireSeller(request, orderString(input.Intent, "seller"), input.ChainID); err != nil {
		writeUserAuthError(writer, request, err)
		return
	}
	saved, status, err := service.persistSignedOrder(request, input)
	if errors.Is(err, errSignedOrderConflict) {
		writeProblem(writer, request, 409, "Order conflict", err.Error())
		return
	}
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The order could not be stored durably.")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, status, saved)
}
func (service *rwaService) persistSignedOrder(request *http.Request, input signedOrder) (signedOrder, int, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return signedOrder{}, 0, err
	}
	digest := sha256.Sum256(raw)
	asset := orderString(input.Intent, "assetToken")
	token := ""
	if input.Kind == "whole" {
		asset = orderString(input.Intent, "collection")
		token = orderString(input.Intent, "tokenId")
	}
	// The unique-key insert holds its conflict lock until the transaction finishes.
	// Replays cannot change stored bytes or original publication priority.
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return signedOrder{}, 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(request.Context(), `INSERT IGNORE INTO native_signed_orders (chain_id,market_address,intent_hash,kind,seller_address,asset_address,token_id,envelope_json,payload_hash) VALUES (?,?,?,?,?,?,?,?,?) `, input.ChainID, input.MarketAddress, input.IntentHash, input.Kind, orderString(input.Intent, "seller"), asset, token, raw, digest[:])
	if err != nil {
		return signedOrder{}, 0, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return signedOrder{}, 0, err
	}
	var stored []byte
	var fingerprint []byte
	var created time.Time
	if err = tx.QueryRowContext(request.Context(), `SELECT envelope_json,payload_hash,created_at FROM native_signed_orders WHERE chain_id=? AND market_address=? AND intent_hash=? FOR UPDATE`, input.ChainID, input.MarketAddress, input.IntentHash).Scan(&stored, &fingerprint, &created); err != nil {
		return signedOrder{}, 0, err
	}
	if !bytes.Equal(fingerprint, digest[:]) {
		return signedOrder{}, 0, errSignedOrderConflict
	}
	var saved signedOrder
	if err = json.Unmarshal(stored, &saved); err != nil {
		return signedOrder{}, 0, err
	}
	saved.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	if err = tx.Commit(); err != nil {
		return signedOrder{}, 0, err
	}
	status := http.StatusOK
	if changed == 1 {
		status = http.StatusCreated
	}
	return saved, status, nil
}

func signedOrderFilters(values url.Values) (string, []any, error) {
	allowed := map[string]bool{"kind": true, "chainId": true, "marketAddress": true, "assetAddress": true, "tokenId": true, "sellerAddress": true, "page": true, "pageSize": true}
	columns := map[string]string{"kind": "kind", "chainId": "chain_id", "marketAddress": "market_address", "assetAddress": "asset_address", "tokenId": "token_id", "sellerAddress": "seller_address"}
	var clauses []string
	var args []any
	for key, list := range values {
		if !allowed[key] || len(list) != 1 || list[0] == "" {
			return "", nil, errors.New("unsupported or duplicate order filter")
		}
	}
	for _, key := range []string{"kind", "chainId", "marketAddress", "assetAddress", "tokenId", "sellerAddress"} {
		value := values.Get(key)
		if value == "" {
			continue
		}
		valid := true
		switch key {
		case "kind":
			valid = value == "whole" || value == "fraction"
		case "chainId":
			valid = value == strconv.Itoa(hoodiChainID)
		case "tokenId":
			valid = canonicalUint256(value)
		default:
			valid = addressPattern.MatchString(value)
			value = strings.ToLower(value)
		}
		if !valid {
			return "", nil, errors.New("malformed order filter")
		}
		clauses = append(clauses, columns[key]+"=?")
		args = append(args, value)
	}
	for _, key := range []string{"page", "pageSize"} {
		if value := values.Get(key); value != "" {
			n, e := strconv.Atoi(value)
			if e != nil || n < 1 || (key == "pageSize" && n > 100) || (key == "page" && n > 1000000) {
				return "", nil, errors.New("invalid order pagination")
			}
		}
	}
	if len(clauses) == 0 {
		return "", args, nil
	}
	return " WHERE " + strings.Join(clauses, " AND "), args, nil
}
func (service *rwaService) getSignedOrders(writer http.ResponseWriter, request *http.Request) {
	where, args, err := signedOrderFilters(request.URL.Query())
	if err != nil {
		writeProblem(writer, request, 400, "Invalid order query", err.Error())
		return
	}
	if service.db == nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The order index is not connected to persistence.")
		return
	}
	countRows, err := service.db.QueryContext(request.Context(), "SELECT COUNT(*) FROM native_signed_orders"+where, args...)
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "Orders could not be read.")
		return
	}
	var total int
	if !countRows.Next() {
		countRows.Close()
		writeProblem(writer, request, 503, "Order storage unavailable", "Order count is unavailable.")
		return
	}
	err = countRows.Scan(&total)
	countRows.Close()
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "Order count is unavailable.")
		return
	}
	page, pageSize := pagination(request)
	queryArgs := append(append([]any{}, args...), pageSize, (page-1)*pageSize)
	rows, err := service.db.QueryContext(request.Context(), "SELECT envelope_json,created_at FROM native_signed_orders"+where+" ORDER BY created_at ASC,intent_hash ASC,chain_id ASC,market_address ASC LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "Orders could not be read.")
		return
	}
	defer rows.Close()
	data := make([]signedOrder, 0)
	for rows.Next() {
		order, err := scanSignedOrder(rows)
		if err != nil {
			writeProblem(writer, request, 503, "Order storage unavailable", "Stored order data is unavailable.")
			return
		}
		data = append(data, order)
	}
	if rows.Err() != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "Orders could not be read.")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, 200, map[string]any{"data": data, "total": total, "page": page, "pageSize": pageSize})
}
func scanSignedOrder(rows *sql.Rows) (signedOrder, error) {
	var raw []byte
	var created time.Time
	var order signedOrder
	err := rows.Scan(&raw, &created)
	if err == nil {
		err = json.Unmarshal(raw, &order)
	}
	order.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return order, err
}
func (service *rwaService) getSignedOrder(writer http.ResponseWriter, request *http.Request) {
	values := request.URL.Query()
	hash := strings.ToLower(request.PathValue("intentHash"))
	if !txHashPattern.MatchString(hash) || len(values) != 2 || len(values["chainId"]) != 1 || len(values["marketAddress"]) != 1 || values.Get("chainId") != strconv.Itoa(hoodiChainID) || !addressPattern.MatchString(values.Get("marketAddress")) {
		writeProblem(writer, request, 400, "Invalid order scope", "A valid hash, chain and market are required.")
		return
	}
	if service.db == nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The order index is not connected to persistence.")
		return
	}
	rows, err := service.db.QueryContext(request.Context(), `SELECT envelope_json,created_at FROM native_signed_orders WHERE chain_id=? AND market_address=? AND intent_hash=?`, hoodiChainID, strings.ToLower(values.Get("marketAddress")), hash)
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The order could not be read.")
		return
	}
	defer rows.Close()
	if !rows.Next() {
		if rows.Err() != nil {
			writeProblem(writer, request, 503, "Order storage unavailable", "The order could not be read.")
		} else {
			writeProblem(writer, request, 404, "Order not found", "No order matches this public scope.")
		}
		return
	}
	order, err := scanSignedOrder(rows)
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The stored order is unavailable.")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, 200, order)
}
