package httpapi

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	marketActionFulfillListing = "fulfill-listing"
	maxFulfillmentResponseSize = 1 << 20
)

var calldataPattern = regexp.MustCompile(`^0x(?:[0-9a-fA-F]{2})*$`)

type marketAsset struct {
	Source               string `json:"source"`
	Chain                string `json:"chain"`
	ContractAddress      string `json:"contractAddress"`
	TokenID              string `json:"tokenId"`
	CollectionSlug       string `json:"collectionSlug,omitempty"`
	LatestEventType      string `json:"latestEventType"`
	LatestEventTimestamp string `json:"latestEventTimestamp"`
	OrderHash            string `json:"orderHash,omitempty"`
	OrderStatus          string `json:"orderStatus,omitempty"`
	Price                string `json:"price,omitempty"`
	PaymentSymbol        string `json:"paymentSymbol,omitempty"`
	MarketplaceURL       string `json:"marketplaceUrl,omitempty"`
}

type marketIntentRequest struct {
	Source        string `json:"source"`
	Action        string `json:"action"`
	Chain         string `json:"chain"`
	OrderHash     string `json:"orderHash"`
	WalletAddress string `json:"walletAddress"`
}

type marketTransaction struct {
	Chain    string `json:"chain"`
	To       string `json:"to"`
	Data     string `json:"data"`
	Value    string `json:"value"`
	ValueHex string `json:"valueHex,omitempty"`
}

type marketIntent struct {
	IntentID          string              `json:"intentId"`
	Source            string              `json:"source"`
	Action            string              `json:"action"`
	Chain             string              `json:"chain"`
	OrderHash         string              `json:"orderHash"`
	ContractAddress   string              `json:"contractAddress"`
	TokenID           string              `json:"tokenId"`
	WalletAddress     string              `json:"walletAddress"`
	Status            string              `json:"status"`
	MarketplaceURL    string              `json:"marketplaceUrl"`
	Transactions      []marketTransaction `json:"transactions"`
	TransactionHash   string              `json:"transactionHash,omitempty"`
	ExternalTxHash    string              `json:"externalTransactionHash,omitempty"`
	FailureCode       string              `json:"failureCode,omitempty"`
	ExternalEventTime string              `json:"externalEventTimestamp,omitempty"`
	CreatedAt         string              `json:"createdAt"`
	UpdatedAt         string              `json:"updatedAt"`
}

type marketSubmissionRequest struct {
	TransactionHash string `json:"transactionHash"`
}

type openseaFulfillmentResponse struct {
	Transactions []struct {
		Chain    string `json:"chain"`
		To       string `json:"to"`
		Data     string `json:"data"`
		Value    string `json:"value"`
		ValueHex string `json:"value_hex"`
	} `json:"transactions"`
}

func (service *rwaService) getMarketAssets(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeJSON(writer, http.StatusOK, map[string]any{
			"data": []marketAsset{}, "total": 0, "page": 1, "pageSize": 100,
			"schemaVersion": "1", "source": "opensea", "runtime": true,
		})
		return
	}
	source := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("source")))
	if source == "" {
		source = "opensea"
	}
	if _, ok := service.marketplaceSources[source]; !ok {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid marketplace source", "The requested source is not approved.")
		return
	}
	page, pageSize := pagination(request)
	contract := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("contract")))
	if contract != "" && !addressPattern.MatchString(contract) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid contract", "Contract must be a 20-byte Ethereum address.")
		return
	}

	where := "source = ? AND contract_address IS NOT NULL AND token_id IS NOT NULL"
	args := []any{source}
	if contract != "" {
		where += " AND contract_address = ?"
		args = append(args, contract)
	}
	var total int
	countRows, err := service.db.QueryContext(request.Context(), `
		SELECT COUNT(*) FROM (
			SELECT chain_name, contract_address, token_id FROM external_market_events
			WHERE `+where+` GROUP BY chain_name, contract_address, token_id
		) catalog`, args...)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market catalog unavailable", "The mirrored NFT catalog could not be counted.")
		return
	}
	if countRows.Next() {
		err = countRows.Scan(&total)
	}
	countRows.Close()
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market catalog unavailable", "The mirrored NFT catalog count could not be decoded.")
		return
	}

	query := `
		WITH ranked AS (
			SELECT source, chain_name, contract_address, token_id,
			       COALESCE(collection_slug, '') AS collection_slug, event_type,
			       DATE_FORMAT(event_timestamp, '%Y-%m-%dT%H:%i:%s.%fZ') AS event_timestamp,
			       ROW_NUMBER() OVER (
			           PARTITION BY source, chain_name, contract_address, token_id
			           ORDER BY event_timestamp DESC, received_at DESC, event_id DESC
			       ) AS rn
			FROM external_market_events WHERE ` + where + `
		), latest_orders AS (
			SELECT source, chain_name, contract_address, token_id, order_hash, status,
			       COALESCE(price, '') AS price,
			       COALESCE(payment_symbol, '') AS payment_symbol,
			       COALESCE(marketplace_url, '') AS marketplace_url,
			       ROW_NUMBER() OVER (
			           PARTITION BY source, chain_name, contract_address, token_id
			           ORDER BY (status = 'active') DESC, event_timestamp DESC, updated_at DESC
			       ) AS rn
			FROM external_market_orders
		)
		SELECT ranked.source, ranked.chain_name, ranked.contract_address, ranked.token_id,
		       ranked.collection_slug, ranked.event_type, ranked.event_timestamp,
		       COALESCE(latest_orders.order_hash, ''), COALESCE(latest_orders.status, ''),
		       COALESCE(latest_orders.price, ''), COALESCE(latest_orders.payment_symbol, ''),
		       COALESCE(latest_orders.marketplace_url, '')
		FROM ranked
		LEFT JOIN latest_orders ON latest_orders.source = ranked.source
		 AND latest_orders.chain_name = ranked.chain_name
		 AND latest_orders.contract_address = ranked.contract_address
		 AND latest_orders.token_id = ranked.token_id
		 AND latest_orders.rn = 1
		WHERE ranked.rn = 1
		ORDER BY ranked.event_timestamp DESC, ranked.contract_address, ranked.token_id
		LIMIT ? OFFSET ?`
	queryArgs := append(args, pageSize, (page-1)*pageSize)
	rows, err := service.db.QueryContext(request.Context(), query, queryArgs...)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market catalog unavailable", "The mirrored NFT catalog could not be queried.")
		return
	}
	defer rows.Close()
	items := make([]marketAsset, 0)
	for rows.Next() {
		var item marketAsset
		if err := rows.Scan(
			&item.Source, &item.Chain, &item.ContractAddress, &item.TokenID,
			&item.CollectionSlug, &item.LatestEventType, &item.LatestEventTimestamp,
			&item.OrderHash, &item.OrderStatus, &item.Price, &item.PaymentSymbol,
			&item.MarketplaceURL,
		); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market catalog unavailable", "The mirrored NFT catalog could not be decoded.")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market catalog unavailable", "The mirrored NFT catalog query was interrupted.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"data": items, "total": total, "page": page, "pageSize": pageSize,
		"schemaVersion": "1", "source": source, "runtime": true,
	})
}

func (service *rwaService) createMarketIntent(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "Durable persistence is required.")
		return
	}
	if !service.externalTradeEnabled || service.openseaAPIKey == "" {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration gated", "External transaction generation requires a separately approved runtime release.")
		return
	}
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if len(idempotencyKey) < 16 || len(idempotencyKey) > 128 {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid idempotency key", "Idempotency-Key must contain 16 to 128 characters.")
		return
	}
	var input marketIntentRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market intent", err.Error())
		return
	}
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	input.Action = strings.ToLower(strings.TrimSpace(input.Action))
	input.Chain = strings.ToLower(strings.TrimSpace(input.Chain))
	input.OrderHash = strings.ToLower(strings.TrimSpace(input.OrderHash))
	input.WalletAddress = strings.ToLower(strings.TrimSpace(input.WalletAddress))
	if _, ok := service.marketplaceSources[input.Source]; !ok || input.Source != "opensea" ||
		input.Action != marketActionFulfillListing || !marketChainPattern.MatchString(input.Chain) ||
		!txHashPattern.MatchString(input.OrderHash) || !addressPattern.MatchString(input.WalletAddress) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market intent", "Use an approved OpenSea listing, chain, order hash, and external wallet address.")
		return
	}

	canonical, _ := json.Marshal(input)
	payloadDigest := sha256.Sum256(canonical)
	keyDigest := sha256.Sum256([]byte(idempotencyKey))
	existing, err := service.marketIntentByIdempotency(request, hex.EncodeToString(keyDigest[:]))
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The idempotency record could not be checked.")
		return
	}
	if existing != nil {
		storedPayload, err := service.marketIntentPayloadHash(request, existing.IntentID)
		if err != nil || storedPayload != hex.EncodeToString(payloadDigest[:]) {
			writeProblem(writer, request, http.StatusConflict, "Idempotency conflict", "The key was already used with a different market intent.")
			return
		}
		writeJSON(writer, http.StatusOK, existing)
		return
	}

	order, protocolAddress, err := service.loadActiveMarketOrder(request, input)
	if err != nil {
		if errors.Is(err, errMarketOrderUnavailable) {
			writeProblem(writer, request, http.StatusConflict, "Listing unavailable", "The mirrored OpenSea listing is not active or lacks an approved fulfillment contract.")
			return
		}
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The mirrored listing could not be read.")
		return
	}
	if strings.EqualFold(order.MakerAddress, input.WalletAddress) {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Self-fulfillment blocked", "The listing maker cannot fulfill the same mirrored listing.")
		return
	}
	if service.recentMarketIntentCount(request, input.WalletAddress) >= 5 {
		writeProblem(writer, request, http.StatusTooManyRequests, "Too many market intents", "Wait before requesting another external transaction plan.")
		return
	}

	intent := &marketIntent{
		IntentID: randomID(), Source: input.Source, Action: input.Action, Chain: input.Chain,
		OrderHash: input.OrderHash, ContractAddress: order.ContractAddress, TokenID: order.TokenID,
		WalletAddress: input.WalletAddress, Status: "initiated", MarketplaceURL: order.MarketplaceURL,
		Transactions: []marketTransaction{},
	}
	if err := service.insertMarketIntent(request, intent, hex.EncodeToString(keyDigest[:]), hex.EncodeToString(payloadDigest[:])); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The market intent could not be stored durably.")
		return
	}

	transactions, failureCode, err := service.requestOpenSeaFulfillment(request, input, protocolAddress, order.Price)
	if err != nil {
		_ = service.rejectMarketIntent(request, intent.IntentID, failureCode)
		intent.Status = "rejected"
		intent.FailureCode = failureCode
		writeProblem(writer, request, http.StatusBadGateway, "OpenSea transaction plan rejected", "OpenSea did not return a safe, executable transaction plan. No wallet request was made.")
		return
	}
	if err := service.acceptMarketIntent(request, intent.IntentID, transactions); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The approved transaction plan could not be stored durably.")
		return
	}
	intent.Status = "awaiting-wallet"
	intent.Transactions = transactions
	intent.CreatedAt = service.now().Format(time.RFC3339)
	intent.UpdatedAt = intent.CreatedAt
	writeJSON(writer, http.StatusCreated, intent)
}

var errMarketOrderUnavailable = errors.New("market order unavailable")

type activeMarketOrder struct {
	ContractAddress string
	TokenID         string
	MakerAddress    string
	Price           string
	MarketplaceURL  string
}

func (service *rwaService) loadActiveMarketOrder(request *http.Request, input marketIntentRequest) (activeMarketOrder, string, error) {
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT COALESCE(contract_address, ''), COALESCE(token_id, ''), COALESCE(maker_address, ''),
		       COALESCE(price, ''), COALESCE(marketplace_url, ''), payload
		FROM external_market_orders
		WHERE source = ? AND chain_name = ? AND order_hash = ? AND status = 'active'`,
		input.Source, input.Chain, input.OrderHash)
	if err != nil {
		return activeMarketOrder{}, "", err
	}
	defer rows.Close()
	if !rows.Next() {
		return activeMarketOrder{}, "", errMarketOrderUnavailable
	}
	var order activeMarketOrder
	var payload []byte
	if err := rows.Scan(&order.ContractAddress, &order.TokenID, &order.MakerAddress, &order.Price, &order.MarketplaceURL, &payload); err != nil {
		return activeMarketOrder{}, "", err
	}
	if !addressPattern.MatchString(order.ContractAddress) || !uint256Pattern.MatchString(order.TokenID) ||
		!addressPattern.MatchString(order.MakerAddress) || !uint256Pattern.MatchString(order.Price) ||
		!approvedMarketplaceURL(order.MarketplaceURL, input.Source) {
		return activeMarketOrder{}, "", errMarketOrderUnavailable
	}
	var decoded any
	if json.Unmarshal(payload, &decoded) != nil {
		return activeMarketOrder{}, "", errMarketOrderUnavailable
	}
	protocolAddress := findJSONText(decoded, "protocol_address")
	if !addressPattern.MatchString(protocolAddress) {
		return activeMarketOrder{}, "", errMarketOrderUnavailable
	}
	return order, strings.ToLower(protocolAddress), nil
}

func approvedMarketplaceURL(value, source string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.User == nil &&
		(source != "opensea" || parsed.Hostname() == "opensea.io")
}

func findJSONText(value any, key string) string {
	switch typed := value.(type) {
	case map[string]any:
		if direct, ok := typed[key].(string); ok {
			return strings.TrimSpace(direct)
		}
		for _, nested := range typed {
			if found := findJSONText(nested, key); found != "" {
				return found
			}
		}
	case []any:
		for _, nested := range typed {
			if found := findJSONText(nested, key); found != "" {
				return found
			}
		}
	}
	return ""
}

func (service *rwaService) requestOpenSeaFulfillment(request *http.Request, input marketIntentRequest, protocolAddress, maximumValue string) ([]marketTransaction, string, error) {
	body := map[string]any{
		"listings": []map[string]string{{
			"hash": input.OrderHash, "chain": input.Chain, "protocol_address": protocolAddress,
		}},
		"fulfiller": map[string]string{"address": input.WalletAddress},
		"payment": map[string]string{
			"chain": input.Chain, "address": "0x0000000000000000000000000000000000000000",
		},
		"recipient": input.WalletAddress,
	}
	encoded, _ := json.Marshal(body)
	endpoint := strings.TrimRight(service.openseaAPIBaseURL, "/") + "/api/v2/listings/cross_chain_fulfillment_data"
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, "request-build-failed", err
	}
	upstreamRequest.Header.Set("Content-Type", "application/json")
	upstreamRequest.Header.Set("Accept", "application/json")
	upstreamRequest.Header.Set("X-API-Key", service.openseaAPIKey)
	response, err := service.marketHTTPClient.Do(upstreamRequest)
	if err != nil {
		return nil, "upstream-unavailable", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxFulfillmentResponseSize))
		return nil, fmt.Sprintf("upstream-%d", response.StatusCode), errors.New("OpenSea rejected the fulfillment request")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxFulfillmentResponseSize+1))
	if err != nil || len(data) > maxFulfillmentResponseSize {
		return nil, "upstream-response-invalid", errors.New("OpenSea fulfillment response is invalid")
	}
	var upstream openseaFulfillmentResponse
	if json.Unmarshal(data, &upstream) != nil || len(upstream.Transactions) != 1 {
		return nil, "unsafe-transaction-count", errors.New("only one same-chain transaction is accepted")
	}
	maximum, ok := new(big.Int).SetString(maximumValue, 10)
	if !ok {
		return nil, "unsafe-listing-price", errors.New("listing price is invalid")
	}
	transactions := make([]marketTransaction, 0, 1)
	for _, candidate := range upstream.Transactions {
		candidate.Chain = strings.ToLower(strings.TrimSpace(candidate.Chain))
		candidate.To = strings.ToLower(strings.TrimSpace(candidate.To))
		candidate.Data = strings.TrimSpace(candidate.Data)
		candidate.Value = strings.TrimSpace(candidate.Value)
		candidate.ValueHex = strings.TrimSpace(candidate.ValueHex)
		value, ok := new(big.Int).SetString(candidate.Value, 10)
		if !ok || value.Sign() < 0 || value.Cmp(maximum) > 0 || candidate.Chain != input.Chain ||
			!strings.EqualFold(candidate.To, protocolAddress) || !addressPattern.MatchString(candidate.To) ||
			len(candidate.Data) <= 2 || !calldataPattern.MatchString(candidate.Data) || len(candidate.Data) > 262_146 ||
			!consistentHexValue(value, candidate.ValueHex) {
			return nil, "unsafe-transaction-plan", errors.New("OpenSea returned an unsafe transaction")
		}
		transactions = append(transactions, marketTransaction{
			Chain: candidate.Chain, To: candidate.To, Data: candidate.Data,
			Value: candidate.Value, ValueHex: candidate.ValueHex,
		})
	}
	return transactions, "", nil
}

func consistentHexValue(decimal *big.Int, hexadecimal string) bool {
	if hexadecimal == "" || !calldataPattern.MatchString(hexadecimal) {
		return false
	}
	value, ok := new(big.Int).SetString(strings.TrimPrefix(hexadecimal, "0x"), 16)
	return ok && value.Cmp(decimal) == 0
}

func (service *rwaService) recordMarketSubmission(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "Durable persistence is required.")
		return
	}
	var input marketSubmissionRequest
	if err := decodeJSON(request, &input); err != nil || !txHashPattern.MatchString(input.TransactionHash) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid transaction hash", "Use a 32-byte 0x-prefixed transaction hash returned by the external wallet.")
		return
	}
	result, err := service.db.ExecContext(request.Context(), `
		UPDATE external_market_intents
		SET status = 'submitted', submitted_transaction_hash = LOWER(?)
		WHERE intent_id = ? AND status IN ('awaiting-wallet', 'submitted', 'pending')
		  AND (submitted_transaction_hash IS NULL OR submitted_transaction_hash = LOWER(?))`,
		input.TransactionHash, request.PathValue("intentID"), input.TransactionHash)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The wallet submission could not be stored durably.")
		return
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		writeProblem(writer, request, http.StatusConflict, "Market intent conflict", "The intent is missing, terminal, or already bound to another transaction.")
		return
	}
	intent, err := service.marketIntentByID(request, request.PathValue("intentID"))
	if err != nil || intent == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The updated intent could not be read.")
		return
	}
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) getMarketIntent(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "Durable persistence is required.")
		return
	}
	intent, err := service.marketIntentByID(request, request.PathValue("intentID"))
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Trade orchestration unavailable", "The market intent could not be read.")
		return
	}
	if intent == nil {
		writeProblem(writer, request, http.StatusNotFound, "Market intent not found", "No external market intent matches the requested identifier.")
		return
	}
	writeJSON(writer, http.StatusOK, intent)
}

func (service *rwaService) marketIntentByIdempotency(request *http.Request, keyHash string) (*marketIntent, error) {
	return service.queryMarketIntent(request, "idempotency_key_hash = UNHEX(?)", keyHash)
}

func (service *rwaService) marketIntentByID(request *http.Request, intentID string) (*marketIntent, error) {
	return service.queryMarketIntent(request, "intent_id = ?", intentID)
}

func (service *rwaService) queryMarketIntent(request *http.Request, where string, argument any) (*marketIntent, error) {
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT intent_id, source, action, chain_name, order_hash, contract_address, token_id,
		       wallet_address, status, marketplace_url, COALESCE(transaction_plan, JSON_ARRAY()),
		       COALESCE(submitted_transaction_hash, ''), COALESCE(external_transaction_hash, ''),
		       COALESCE(failure_code, ''),
		       COALESCE(DATE_FORMAT(external_event_timestamp, '%Y-%m-%dT%H:%i:%s.%fZ'), ''),
		       DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'),
		       DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ')
		FROM external_market_intents WHERE `+where, argument)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	intent := &marketIntent{}
	var plan []byte
	if err := rows.Scan(
		&intent.IntentID, &intent.Source, &intent.Action, &intent.Chain, &intent.OrderHash,
		&intent.ContractAddress, &intent.TokenID, &intent.WalletAddress, &intent.Status,
		&intent.MarketplaceURL, &plan, &intent.TransactionHash, &intent.ExternalTxHash,
		&intent.FailureCode, &intent.ExternalEventTime, &intent.CreatedAt, &intent.UpdatedAt,
	); err != nil {
		return nil, err
	}
	intent.Transactions = []marketTransaction{}
	if len(plan) > 0 && string(plan) != "null" && json.Unmarshal(plan, &intent.Transactions) != nil {
		return nil, errors.New("stored transaction plan is invalid")
	}
	return intent, rows.Err()
}

func (service *rwaService) marketIntentPayloadHash(request *http.Request, intentID string) (string, error) {
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT LOWER(HEX(payload_hash)) FROM external_market_intents WHERE intent_id = ?`, intentID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if !rows.Next() {
		return "", errors.New("market intent not found")
	}
	var value string
	if err := rows.Scan(&value); err != nil {
		return "", err
	}
	return value, nil
}

func (service *rwaService) recentMarketIntentCount(request *http.Request, wallet string) int {
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT COUNT(*) FROM external_market_intents
		WHERE wallet_address = ? AND created_at >= CURRENT_TIMESTAMP(6) - INTERVAL 1 MINUTE`, wallet)
	if err != nil {
		return 5
	}
	defer rows.Close()
	var count int
	if !rows.Next() || rows.Scan(&count) != nil {
		return 5
	}
	return count
}

func (service *rwaService) insertMarketIntent(request *http.Request, intent *marketIntent, keyHash, payloadHash string) error {
	_, err := service.db.ExecContext(request.Context(), `
		INSERT INTO external_market_intents
		    (intent_id, idempotency_key_hash, payload_hash, source, action, chain_name,
		     order_hash, contract_address, token_id, wallet_address, status, marketplace_url)
		VALUES (?, UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?, ?, 'initiated', ?)`,
		intent.IntentID, keyHash, payloadHash, intent.Source, intent.Action, intent.Chain,
		intent.OrderHash, intent.ContractAddress, intent.TokenID, intent.WalletAddress,
		intent.MarketplaceURL)
	return err
}

func (service *rwaService) acceptMarketIntent(request *http.Request, intentID string, transactions []marketTransaction) error {
	plan, err := json.Marshal(transactions)
	if err != nil {
		return err
	}
	_, err = service.db.ExecContext(request.Context(), `
		UPDATE external_market_intents SET status = 'awaiting-wallet', transaction_plan = ?
		WHERE intent_id = ? AND status = 'initiated'`, plan, intentID)
	return err
}

func (service *rwaService) rejectMarketIntent(request *http.Request, intentID, code string) error {
	_, err := service.db.ExecContext(request.Context(), `
		UPDATE external_market_intents SET status = 'rejected', failure_code = ?
		WHERE intent_id = ? AND status = 'initiated'`, code, intentID)
	return err
}

func reconcileMarketIntents(tx *sql.Tx, input marketEventRequest, eventTimestamp time.Time) error {
	if input.OrderHash == "" {
		return nil
	}
	status := ""
	failureCode := ""
	switch {
	case input.EventFamily == "sale" || input.EventType == "item_sold" || input.EventType == "sale":
		status = "confirmed"
	case input.EventType == "item_cancelled":
		status = "cancelled"
	case input.EventType == "order_invalidate":
		status = "failed"
		failureCode = "external-order-invalidated"
	case input.EventType == "order_revalidate":
		status = "pending"
	default:
		return nil
	}
	_, err := tx.Exec(`
		UPDATE external_market_intents
		SET status = ?,
		    external_transaction_hash = COALESCE(NULLIF(LOWER(?), ''), external_transaction_hash),
		    failure_code = NULLIF(?, ''),
		    external_event_timestamp = GREATEST(COALESCE(external_event_timestamp, ?), ?)
		WHERE source = ? AND chain_name = ? AND order_hash = ?
		  AND status NOT IN ('confirmed', 'failed', 'cancelled', 'rejected')
		  AND (external_event_timestamp IS NULL OR external_event_timestamp <= ?)`,
		status, input.TransactionHash, failureCode, eventTimestamp, eventTimestamp,
		input.Source, input.Chain, strings.ToLower(input.OrderHash), eventTimestamp)
	return err
}
