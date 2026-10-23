package httpapi

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	marketSourcePattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	marketChainPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	marketEntityPattern  = regexp.MustCompile(`^[A-Za-z0-9:/_.-]{1,196}$`)
	marketEventIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

var marketEventTypes = map[string]struct{}{
	"item_listed": {}, "item_sold": {}, "item_transferred": {},
	"item_metadata_updated": {}, "item_received_offer": {}, "item_received_bid": {},
	"item_cancelled": {}, "collection_offer": {}, "trait_offer": {},
	"order_invalidate": {}, "order_revalidate": {},
	"sale": {}, "transfer": {}, "mint": {}, "listing": {}, "offer": {},
}

var marketEventFamilies = map[string]struct{}{
	"order": {}, "sale": {}, "transfer": {}, "metadata": {},
}

type marketEventRequest struct {
	SchemaVersion       string         `json:"schemaVersion"`
	Source              string         `json:"source"`
	EventType           string         `json:"eventType"`
	EventFamily         string         `json:"eventFamily"`
	EntityKey           string         `json:"entityKey"`
	Version             uint64         `json:"version"`
	Chain               string         `json:"chain"`
	CollectionSlug      string         `json:"collectionSlug"`
	OrderHash           string         `json:"orderHash"`
	TransactionHash     string         `json:"transactionHash"`
	ContractAddress     string         `json:"contractAddress"`
	TokenID             string         `json:"tokenId"`
	MakerAddress        string         `json:"makerAddress"`
	Price               string         `json:"price"`
	PaymentTokenAddress string         `json:"paymentTokenAddress"`
	PaymentSymbol       string         `json:"paymentSymbol"`
	MarketplaceURL      string         `json:"marketplaceUrl"`
	EventTimestamp      string         `json:"eventTimestamp"`
	Payload             map[string]any `json:"payload"`
}

type marketActivity struct {
	EventID             string         `json:"eventId"`
	SchemaVersion       string         `json:"schemaVersion"`
	Source              string         `json:"source"`
	EventType           string         `json:"eventType"`
	EventFamily         string         `json:"eventFamily"`
	EntityKey           string         `json:"entityKey"`
	Version             uint64         `json:"version"`
	Chain               string         `json:"chain"`
	CollectionSlug      string         `json:"collectionSlug,omitempty"`
	OrderHash           string         `json:"orderHash,omitempty"`
	TransactionHash     string         `json:"transactionHash,omitempty"`
	ContractAddress     string         `json:"contractAddress,omitempty"`
	TokenID             string         `json:"tokenId,omitempty"`
	MakerAddress        string         `json:"makerAddress,omitempty"`
	Price               string         `json:"price,omitempty"`
	PaymentTokenAddress string         `json:"paymentTokenAddress,omitempty"`
	PaymentSymbol       string         `json:"paymentSymbol,omitempty"`
	MarketplaceURL      string         `json:"marketplaceUrl,omitempty"`
	EventTimestamp      string         `json:"eventTimestamp"`
	Payload             map[string]any `json:"payload"`
	Status              string         `json:"status"`
}

type marketActivityResponse struct {
	Data          []marketActivity `json:"data"`
	SchemaVersion string           `json:"schemaVersion"`
	Source        string           `json:"source"`
	Execution     string           `json:"execution"`
	Custody       bool             `json:"custody"`
	NextCursor    string           `json:"nextCursor,omitempty"`
	HasMore       bool             `json:"hasMore"`
}

type marketActivityCursor struct {
	SchemaVersion  int    `json:"v"`
	EventTimestamp string `json:"t"`
	ReceivedAt     string `json:"r"`
	EventID        string `json:"i"`
	FilterHash     string `json:"f"`
}

func marketActivityFilterHash(source, chain, contract, tokenID, eventFamily, status string) string {
	material := strings.Join([]string{source, chain, contract, tokenID, eventFamily, status}, "\x00")
	digest := sha256.Sum256([]byte(material))
	return hex.EncodeToString(digest[:])
}

func validMarketUint256(value string) bool {
	if !uint256Pattern.MatchString(value) {
		return false
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	return ok && parsed.Sign() >= 0 && parsed.BitLen() <= 256
}

func encodeMarketActivityCursor(eventTimestamp, receivedAt, eventID, filterHash string) string {
	payload, _ := json.Marshal(marketActivityCursor{
		SchemaVersion:  1,
		EventTimestamp: eventTimestamp,
		ReceivedAt:     receivedAt,
		EventID:        eventID,
		FilterHash:     filterHash,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeMarketActivityCursor(value, expectedFilterHash string) (time.Time, time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) > 512 {
		return time.Time{}, time.Time{}, "", fmt.Errorf("invalid activity cursor")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var cursor marketActivityCursor
	if err := decoder.Decode(&cursor); err != nil {
		return time.Time{}, time.Time{}, "", fmt.Errorf("invalid activity cursor")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return time.Time{}, time.Time{}, "", fmt.Errorf("invalid activity cursor")
	}
	eventTimestamp, eventErr := time.Parse(time.RFC3339Nano, cursor.EventTimestamp)
	receivedAt, receivedErr := time.Parse(time.RFC3339Nano, cursor.ReceivedAt)
	if cursor.SchemaVersion != 1 || eventErr != nil || receivedErr != nil ||
		!marketEventIDPattern.MatchString(cursor.EventID) ||
		!marketEventIDPattern.MatchString(cursor.FilterHash) ||
		subtle.ConstantTimeCompare([]byte(cursor.FilterHash), []byte(expectedFilterHash)) != 1 {
		return time.Time{}, time.Time{}, "", fmt.Errorf("invalid activity cursor")
	}
	return eventTimestamp, receivedAt, cursor.EventID, nil
}

func marketActivityStatus(family, eventType string) string {
	switch eventType {
	case "item_cancelled":
		return "cancelled"
	case "order_invalidate":
		return "invalidated"
	}
	switch family {
	case "order":
		return "active"
	case "sale":
		return "fulfilled"
	default:
		return "observed"
	}
}

func parseMarketplaceSources(value string) map[string]struct{} {
	result := map[string]struct{}{}
	if strings.TrimSpace(value) == "" {
		value = "opensea"
	}
	for _, source := range strings.Split(value, ",") {
		source = strings.ToLower(strings.TrimSpace(source))
		if marketSourcePattern.MatchString(source) {
			result[source] = struct{}{}
		}
	}
	return result
}

func (service *rwaService) ingestMarketEvent(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input marketEventRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market event", err.Error())
		return
	}
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	input.Chain = strings.ToLower(strings.TrimSpace(input.Chain))
	input.EventType = strings.ToLower(strings.TrimSpace(input.EventType))
	input.EventFamily = strings.ToLower(strings.TrimSpace(input.EventFamily))
	if err := service.validateMarketEvent(input); err != nil {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market event", err.Error())
		return
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market event", "The source payload is not valid JSON.")
		return
	}
	payloadHash := sha256.Sum256(payload)
	eventIDMaterial := fmt.Sprintf("%s|%s|%s|%s|%d|%s|%s", input.SchemaVersion, input.Source, input.EventFamily, input.EntityKey, input.Version, input.EventType, input.EventTimestamp)
	eventID := sha256.Sum256([]byte(eventIDMaterial))
	status, err := service.persistMarketEvent(request, input, hex.EncodeToString(eventID[:]), payload, payloadHash[:])
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The normalized event could not be stored durably.")
		return
	}
	service.bumpCacheNamespace(request.Context(), "market")
	writeJSON(writer, status, map[string]any{"eventId": hex.EncodeToString(eventID[:]), "status": "mirrored"})
}

func (service *rwaService) validateMarketEvent(input marketEventRequest) error {
	if input.SchemaVersion != "1" {
		return fmt.Errorf("unsupported marketplace event schema version")
	}
	if _, ok := service.marketplaceSources[input.Source]; !ok {
		return fmt.Errorf("marketplace source is not approved")
	}
	if !marketChainPattern.MatchString(input.Chain) || !marketEntityPattern.MatchString(input.EntityKey) || input.Version == 0 {
		return fmt.Errorf("chain, entity key, and monotonic version are required")
	}
	if _, ok := marketEventTypes[input.EventType]; !ok {
		return fmt.Errorf("unsupported marketplace event type")
	}
	if _, ok := marketEventFamilies[input.EventFamily]; !ok {
		return fmt.Errorf("unsupported marketplace event family")
	}
	if input.Payload == nil {
		return fmt.Errorf("original source payload is required")
	}
	if input.OrderHash != "" && !txHashPattern.MatchString(input.OrderHash) {
		return fmt.Errorf("order hash must be a 32-byte hexadecimal value")
	}
	if input.TransactionHash != "" && !txHashPattern.MatchString(input.TransactionHash) {
		return fmt.Errorf("transaction hash must be a 32-byte hexadecimal value")
	}
	for _, address := range []string{input.ContractAddress, input.MakerAddress, input.PaymentTokenAddress} {
		if address != "" && !addressPattern.MatchString(address) {
			return fmt.Errorf("marketplace addresses must be 20-byte hexadecimal values")
		}
	}
	if input.TokenID != "" && !validMarketUint256(input.TokenID) {
		return fmt.Errorf("token id must be an unsigned 256-bit decimal value")
	}
	if input.Price != "" && !validMarketUint256(input.Price) {
		return fmt.Errorf("price must be an unsigned 256-bit decimal value")
	}
	if len(input.CollectionSlug) > 160 || len(input.PaymentSymbol) > 16 {
		return fmt.Errorf("marketplace labels exceed their limits")
	}
	observed, err := time.Parse(time.RFC3339, input.EventTimestamp)
	if err != nil || observed.After(time.Now().UTC().Add(5*time.Minute)) {
		return fmt.Errorf("event timestamp is invalid")
	}
	if input.MarketplaceURL != "" {
		parsed, err := url.Parse(input.MarketplaceURL)
		if err != nil || parsed.Scheme != "https" || parsed.User != nil {
			return fmt.Errorf("marketplace URL must be HTTPS")
		}
		if input.Source == "opensea" && parsed.Hostname() != "opensea.io" {
			return fmt.Errorf("OpenSea events must link to opensea.io")
		}
	}
	return nil
}

func (service *rwaService) persistMarketEvent(request *http.Request, input marketEventRequest, eventID string, payload []byte, payloadHash []byte) (int, error) {
	eventTimestamp, err := time.Parse(time.RFC3339, input.EventTimestamp)
	if err != nil {
		return 0, err
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(request.Context(), `
		INSERT IGNORE INTO external_market_events
		    (event_id, schema_version, source, event_type, event_family, entity_key, event_version,
		     chain_name, collection_slug, order_hash, transaction_hash, contract_address, token_id,
		     maker_address, price, payment_token_address, payment_symbol, marketplace_url,
		     event_timestamp, payload, payload_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
		        NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
		        NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?)`,
		eventID, input.SchemaVersion, input.Source, input.EventType, input.EventFamily, input.EntityKey,
		input.Version, input.Chain, input.CollectionSlug, strings.ToLower(input.OrderHash),
		strings.ToLower(input.TransactionHash), strings.ToLower(input.ContractAddress), input.TokenID,
		strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
		input.PaymentSymbol, input.MarketplaceURL, eventTimestamp, payload, payloadHash)
	if err != nil {
		return 0, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if input.EventFamily == "order" && input.OrderHash != "" {
		status := marketOrderStatus(input.EventType)
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_orders
			    (source, chain_name, order_hash, event_version, status, collection_slug,
			     contract_address, token_id, maker_address, price, payment_token_address,
			     payment_symbol, marketplace_url, event_timestamp, payload)
			VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
			        NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?)
			ON DUPLICATE KEY UPDATE
			    status = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(status), status),
			    collection_slug = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(collection_slug), collection_slug),
			    contract_address = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(contract_address), contract_address),
			    token_id = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(token_id), token_id),
			    maker_address = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(maker_address), maker_address),
			    price = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(price), price),
			    payment_token_address = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(payment_token_address), payment_token_address),
			    payment_symbol = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(payment_symbol), payment_symbol),
			    marketplace_url = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(marketplace_url), marketplace_url),
			    event_timestamp = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(event_timestamp), event_timestamp),
			    payload = IF(fulfilled_at IS NULL AND VALUES(event_version) >= event_version, VALUES(payload), payload),
			    event_version = IF(fulfilled_at IS NULL, GREATEST(event_version, VALUES(event_version)), event_version)`,
			input.Source, input.Chain, strings.ToLower(input.OrderHash), input.Version, status,
			input.CollectionSlug, strings.ToLower(input.ContractAddress), input.TokenID,
			strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
			input.PaymentSymbol, input.MarketplaceURL, eventTimestamp, payload)
		if err != nil {
			return 0, err
		}
	}
	if input.EventFamily == "sale" && input.OrderHash != "" {
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_orders
			    (source, chain_name, order_hash, event_version, status, collection_slug,
			     contract_address, token_id, maker_address, price, payment_token_address,
			     payment_symbol, marketplace_url, event_timestamp, fulfilled_at,
			     fulfillment_transaction_hash, payload)
			VALUES (?, ?, ?, ?, 'fulfilled', NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
			        NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
			        ?, ?, NULLIF(?, ''), ?)
			ON DUPLICATE KEY UPDATE
			    status = 'fulfilled',
			    fulfilled_at = GREATEST(COALESCE(fulfilled_at, VALUES(fulfilled_at)), VALUES(fulfilled_at)),
			    fulfillment_transaction_hash = IF(fulfilled_at IS NULL OR VALUES(fulfilled_at) >= fulfilled_at,
			        VALUES(fulfillment_transaction_hash), fulfillment_transaction_hash)`,
			input.Source, input.Chain, strings.ToLower(input.OrderHash), input.Version,
			input.CollectionSlug, strings.ToLower(input.ContractAddress), input.TokenID,
			strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
			input.PaymentSymbol, input.MarketplaceURL, eventTimestamp, eventTimestamp,
			strings.ToLower(input.TransactionHash), payload)
		if err != nil {
			return 0, err
		}
	}
	if err := reconcileMarketIntents(tx, input, eventTimestamp); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if rows == 0 {
		return http.StatusOK, nil
	}
	return http.StatusCreated, nil
}

func marketOrderStatus(eventType string) string {
	switch eventType {
	case "item_cancelled":
		return "cancelled"
	case "order_invalidate":
		return "invalidated"
	default:
		return "active"
	}
}

func (service *rwaService) getMarketActivity(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market activity unavailable", "Durable marketplace data is unavailable; an empty trading history cannot be inferred.")
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
	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 1 && value <= 100 {
			limit = value
		} else {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid limit", "Limit must be between 1 and 100.")
			return
		}
	}
	contract := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("contract")))
	if contract != "" && !addressPattern.MatchString(contract) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid contract", "Contract must be a 20-byte Ethereum address.")
		return
	}
	chain := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("chain")))
	if chain != "" && !marketChainPattern.MatchString(chain) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid chain", "Chain must be a normalized marketplace chain name.")
		return
	}
	tokenID := strings.TrimSpace(request.URL.Query().Get("tokenId"))
	if tokenID != "" && !validMarketUint256(tokenID) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid token ID", "Token ID must be an unsigned 256-bit decimal value.")
		return
	}
	eventFamily := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("eventFamily")))
	if eventFamily != "" {
		if _, ok := marketEventFamilies[eventFamily]; !ok {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid event family", "Event family is not supported.")
			return
		}
	}
	status := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("status")))
	if status != "" && status != "active" && status != "cancelled" && status != "invalidated" && status != "fulfilled" && status != "observed" {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid activity status", "Status is not supported.")
		return
	}
	var cursorEventTimestamp, cursorReceivedAt time.Time
	var cursorEventID string
	filterHash := marketActivityFilterHash(source, chain, contract, tokenID, eventFamily, status)
	if cursor := strings.TrimSpace(request.URL.Query().Get("cursor")); cursor != "" {
		var err error
		cursorEventTimestamp, cursorReceivedAt, cursorEventID, err = decodeMarketActivityCursor(cursor, filterHash)
		if err != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid cursor", "Cursor is malformed or unsupported.")
			return
		}
	}
	response := marketActivityResponse{
		Data: []marketActivity{}, SchemaVersion: "1", Source: source,
		Execution: "external-deeplink-only", Custody: false,
	}
	cacheToken, cacheHit := service.loadCachedJSON(request.Context(), "market", request.URL.Query().Encode(), &response)
	if cacheHit {
		writeJSON(writer, http.StatusOK, response)
		return
	}
	query := `
		SELECT event_id, schema_version, source, event_type, event_family, entity_key,
		       event_version, chain_name, COALESCE(collection_slug, ''), COALESCE(order_hash, ''),
		       COALESCE(transaction_hash, ''), COALESCE(contract_address, ''), COALESCE(token_id, ''),
		       COALESCE(maker_address, ''), COALESCE(price, ''), COALESCE(payment_token_address, ''),
		       COALESCE(payment_symbol, ''), COALESCE(marketplace_url, ''),
		       DATE_FORMAT(event_timestamp, '%Y-%m-%dT%H:%i:%s.%fZ'), payload,
		       DATE_FORMAT(received_at, '%Y-%m-%dT%H:%i:%s.%fZ')
		FROM external_market_events WHERE source = ?`
	args := []any{source}
	if contract != "" {
		query += " AND contract_address = ?"
		args = append(args, contract)
	}
	if chain != "" {
		query += " AND chain_name = ?"
		args = append(args, chain)
	}
	if tokenID != "" {
		query += " AND token_id = ?"
		args = append(args, tokenID)
	}
	if eventFamily != "" {
		query += " AND event_family = ?"
		args = append(args, eventFamily)
	}
	switch status {
	case "active":
		query += " AND event_family = 'order' AND event_type NOT IN ('item_cancelled', 'order_invalidate')"
	case "cancelled":
		query += " AND event_type = 'item_cancelled'"
	case "invalidated":
		query += " AND event_type = 'order_invalidate'"
	case "fulfilled":
		query += " AND event_family = 'sale'"
	case "observed":
		query += " AND event_family IN ('transfer', 'metadata')"
	}
	if cursorEventID != "" {
		query += ` AND (event_timestamp < ? OR
			(event_timestamp = ? AND received_at < ?) OR
			(event_timestamp = ? AND received_at = ? AND event_id < ?))`
		args = append(args, cursorEventTimestamp, cursorEventTimestamp, cursorReceivedAt,
			cursorEventTimestamp, cursorReceivedAt, cursorEventID)
	}
	query += " ORDER BY event_timestamp DESC, received_at DESC, event_id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := service.db.QueryContext(request.Context(), query, args...)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity could not be queried.")
		return
	}
	defer rows.Close()
	items := make([]marketActivity, 0)
	receivedAtValues := make([]string, 0)
	for rows.Next() {
		var item marketActivity
		var payload []byte
		var receivedAt string
		if err := rows.Scan(&item.EventID, &item.SchemaVersion, &item.Source, &item.EventType,
			&item.EventFamily, &item.EntityKey, &item.Version, &item.Chain, &item.CollectionSlug,
			&item.OrderHash, &item.TransactionHash, &item.ContractAddress, &item.TokenID,
			&item.MakerAddress, &item.Price, &item.PaymentTokenAddress, &item.PaymentSymbol,
			&item.MarketplaceURL, &item.EventTimestamp, &payload, &receivedAt); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity could not be decoded.")
			return
		}
		if err := json.Unmarshal(payload, &item.Payload); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored source payload is invalid.")
			return
		}
		item.Status = marketActivityStatus(item.EventFamily, item.EventType)
		items = append(items, item)
		receivedAtValues = append(receivedAtValues, receivedAt)
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity query was interrupted.")
		return
	}
	if len(items) > limit {
		response.HasMore = true
		items = items[:limit]
		receivedAtValues = receivedAtValues[:limit]
		last := items[len(items)-1]
		response.NextCursor = encodeMarketActivityCursor(
			last.EventTimestamp,
			receivedAtValues[len(receivedAtValues)-1],
			last.EventID,
			filterHash,
		)
	}
	response.Data = items
	service.storeCachedJSON(request.Context(), cacheToken, response)
	writeJSON(writer, http.StatusOK, response)
}
