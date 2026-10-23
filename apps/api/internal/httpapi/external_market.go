package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

var errMarketEventConflict = errors.New("market event version conflicts with its stored content")

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
}

type marketActivityResponse struct {
	Data          []marketActivity `json:"data"`
	SchemaVersion string           `json:"schemaVersion"`
	Source        string           `json:"source"`
	Execution     string           `json:"execution"`
	Custody       bool             `json:"custody"`
	Runtime       bool             `json:"runtime"`
	NextCursor    string           `json:"nextCursor,omitempty"`
}

// The cursor is bound to the query scope, so it cannot silently page through a
// different source or contract. It is a position, not an authorization token.
type marketActivityCursor struct {
	Timestamp string `json:"timestamp"`
	EventID   string `json:"eventId"`
	Source    string `json:"source"`
	Chain     string `json:"chain"`
	Contract  string `json:"contract"`
	TokenID   string `json:"tokenId"`
}

func decodeMarketActivityCursor(raw, source, chain, contract, tokenID string) (marketActivityCursor, error) {
	var cursor marketActivityCursor
	if len(raw) > 1024 {
		return cursor, fmt.Errorf("activity cursor is too long")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(decoded, &cursor) != nil ||
		cursor.Source != source || cursor.Chain != chain || cursor.Contract != contract ||
		cursor.TokenID != tokenID || !marketEventIDPattern.MatchString(cursor.EventID) {
		return cursor, fmt.Errorf("activity cursor is invalid for this query")
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000000Z", cursor.Timestamp)
	if err != nil || parsed.UTC().Format("2006-01-02T15:04:05.000000Z") != cursor.Timestamp {
		return cursor, fmt.Errorf("activity cursor timestamp is invalid")
	}
	return cursor, nil
}

func encodeMarketActivityCursor(item marketActivity, source, chain, contract, tokenID string) string {
	payload, _ := json.Marshal(marketActivityCursor{
		Timestamp: item.EventTimestamp,
		EventID:   item.EventID,
		Source:    source,
		Chain:     chain,
		Contract:  contract,
		TokenID:   tokenID,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
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
	eventIDMaterial := fmt.Sprintf("%s|%s|%s|%s|%s|%d|%s|%s", input.SchemaVersion, input.Source, input.Chain, input.EventFamily, input.EntityKey, input.Version, input.EventType, input.EventTimestamp)
	eventID := sha256.Sum256([]byte(eventIDMaterial))
	status, persistedEventID, err := service.persistMarketEvent(request, input, hex.EncodeToString(eventID[:]), payload, payloadHash[:])
	if errors.Is(err, errMarketEventConflict) {
		writeProblem(writer, request, http.StatusConflict, "Market event conflict", "This event version is already bound to different content.")
		return
	}
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The normalized event could not be stored durably.")
		return
	}
	if status == http.StatusCreated {
		service.bumpCacheNamespace(request.Context(), "market")
	}
	writeJSON(writer, status, map[string]any{"eventId": persistedEventID, "status": "mirrored"})
}

func (service *rwaService) validateMarketEvent(input marketEventRequest) error {
	if input.SchemaVersion != "1" {
		return fmt.Errorf("unsupported marketplace event schema version")
	}
	if _, ok := service.marketplaceSources[input.Source]; !ok {
		return fmt.Errorf("marketplace source is not approved")
	}
	if !marketChainPattern.MatchString(input.Chain) || !marketEntityPattern.MatchString(input.EntityKey) || input.Version == 0 {
		return fmt.Errorf("chain, entity key, and a positive source version are required")
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
	if input.TokenID != "" && !marketUint256(input.TokenID) {
		return fmt.Errorf("token id must be an unsigned 256-bit decimal value")
	}
	if input.Price != "" && !marketUint256(input.Price) {
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

func (service *rwaService) persistMarketEvent(request *http.Request, input marketEventRequest, eventID string, payload []byte, payloadHash []byte) (int, string, error) {
	eventTimestamp, err := time.Parse(time.RFC3339, input.EventTimestamp)
	if err != nil {
		return 0, "", err
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return 0, "", err
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
		return 0, "", err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, "", err
	}
	if rows == 0 {
		// An exact replay has already committed its event and projections together.
		// Conflicting normalized fields must never reach the order upserts below.
		// Lookup by the full chain-scoped tuple, not the freshly computed hash:
		// pre-migration events keep their original IDs, including on replay.
		var persistedEventID string
		err = tx.QueryRowContext(request.Context(), `
			SELECT event_id FROM external_market_events
			WHERE schema_version = ? AND source = ?
			  AND event_type = ? AND event_family = ? AND entity_key = ? AND event_version = ?
			  AND chain_name = ? AND CAST(COALESCE(collection_slug, '') AS BINARY) = ?
			  AND CAST(COALESCE(order_hash, '') AS BINARY) = ? AND CAST(COALESCE(transaction_hash, '') AS BINARY) = ?
			  AND CAST(COALESCE(contract_address, '') AS BINARY) = ? AND CAST(COALESCE(token_id, '') AS BINARY) = ?
			  AND CAST(COALESCE(maker_address, '') AS BINARY) = ? AND CAST(COALESCE(price, '') AS BINARY) = ?
			  AND CAST(COALESCE(payment_token_address, '') AS BINARY) = ? AND CAST(COALESCE(payment_symbol, '') AS BINARY) = ?
			  AND CAST(COALESCE(marketplace_url, '') AS BINARY) = ? AND event_timestamp = ? AND payload_hash = ?`,
			input.SchemaVersion, input.Source, input.EventType, input.EventFamily, input.EntityKey,
			input.Version, input.Chain, input.CollectionSlug, strings.ToLower(input.OrderHash),
			strings.ToLower(input.TransactionHash), strings.ToLower(input.ContractAddress), input.TokenID,
			strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
			input.PaymentSymbol, input.MarketplaceURL, eventTimestamp, payloadHash).Scan(&persistedEventID)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, "", errMarketEventConflict
		}
		if err != nil {
			return 0, "", err
		}
		if err := tx.Commit(); err != nil {
			return 0, "", err
		}
		return http.StatusOK, persistedEventID, nil
	}
	if input.EventFamily == "order" && input.OrderHash != "" {
		status := marketOrderStatus(input.EventType)
		// REST's timestamp fallback and stream revision counters are different
		// scales. Retain event_version as evidence, not as a cross-feed clock.
		// Ties prefer a non-active observation, then a stable event ID.
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO external_market_orders
			    (source, chain_name, order_hash, event_version, status, collection_slug,
			     contract_address, token_id, maker_address, price, payment_token_address,
			     payment_symbol, marketplace_url, event_timestamp, payload, projection_event_id)
			VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
			        NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?)
			ON DUPLICATE KEY UPDATE
			    collection_slug = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(collection_slug), collection_slug),
			    contract_address = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(contract_address), contract_address),
			    token_id = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(token_id), token_id),
			    maker_address = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(maker_address), maker_address),
			    price = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(price), price),
			    payment_token_address = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(payment_token_address), payment_token_address),
			    payment_symbol = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(payment_symbol), payment_symbol),
			    marketplace_url = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(marketplace_url), marketplace_url),
			    payload = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(payload), payload),
			    event_version = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(event_version), event_version),
			    projection_event_id = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(projection_event_id), projection_event_id),
			    status = IF(fulfilled_at IS NULL AND (VALUES(event_timestamp) > event_timestamp OR (VALUES(event_timestamp) = event_timestamp AND (FIELD(VALUES(status), 'active', 'invalidated', 'cancelled') > FIELD(status, 'active', 'invalidated', 'cancelled') OR (VALUES(status) = status AND VALUES(projection_event_id) > COALESCE(projection_event_id, ''))))), VALUES(status), status),
			    event_timestamp = IF(fulfilled_at IS NULL, GREATEST(event_timestamp, VALUES(event_timestamp)), event_timestamp)`,
			input.Source, input.Chain, strings.ToLower(input.OrderHash), input.Version, status,
			input.CollectionSlug, strings.ToLower(input.ContractAddress), input.TokenID,
			strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
			input.PaymentSymbol, input.MarketplaceURL, eventTimestamp, payload, eventID)
		if err != nil {
			return 0, "", err
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
			return 0, "", err
		}
	}
	if err := reconcileMarketIntents(tx, input, eventTimestamp); err != nil {
		return 0, "", err
	}
	if err := tx.Commit(); err != nil {
		return 0, "", err
	}
	return http.StatusCreated, eventID, nil
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
		writeProblem(writer, request, http.StatusBadRequest, "Invalid chain", "Chain must be a supported marketplace chain name.")
		return
	}
	tokenID := strings.TrimSpace(request.URL.Query().Get("tokenId"))
	if tokenID != "" && !marketUint256(tokenID) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid token ID", "Token ID must be an unsigned 256-bit decimal value.")
		return
	}
	var cursor marketActivityCursor
	if raw := request.URL.Query().Get("cursor"); raw != "" {
		var err error
		cursor, err = decodeMarketActivityCursor(raw, source, chain, contract, tokenID)
		if err != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid cursor", err.Error())
			return
		}
	}
	response := marketActivityResponse{
		Data: []marketActivity{}, SchemaVersion: "1", Source: source,
		Execution: "external-deeplink-only", Custody: false, Runtime: true,
	}
	cacheToken, cacheHit := service.loadCachedJSON(request.Context(), "market", "activity:v2:"+request.URL.Query().Encode(), &response)
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
		       DATE_FORMAT(event_timestamp, '%Y-%m-%dT%H:%i:%s.%fZ'), payload
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
	if cursor.EventID != "" {
		query += " AND (event_timestamp < ? OR (event_timestamp = ? AND event_id < ?))"
		position := strings.Replace(cursor.Timestamp[:26], "T", " ", 1)
		args = append(args, position, position, cursor.EventID)
	}
	query += " ORDER BY event_timestamp DESC, event_id DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := service.db.QueryContext(request.Context(), query, args...)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity could not be queried.")
		return
	}
	defer rows.Close()
	items := make([]marketActivity, 0)
	for rows.Next() {
		var item marketActivity
		var payload []byte
		if err := rows.Scan(&item.EventID, &item.SchemaVersion, &item.Source, &item.EventType,
			&item.EventFamily, &item.EntityKey, &item.Version, &item.Chain, &item.CollectionSlug,
			&item.OrderHash, &item.TransactionHash, &item.ContractAddress, &item.TokenID,
			&item.MakerAddress, &item.Price, &item.PaymentTokenAddress, &item.PaymentSymbol,
			&item.MarketplaceURL, &item.EventTimestamp, &payload); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity could not be decoded.")
			return
		}
		if err := json.Unmarshal(payload, &item.Payload); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored source payload is invalid.")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The mirrored activity query was interrupted.")
		return
	}
	if len(items) > limit {
		response.NextCursor = encodeMarketActivityCursor(items[limit-1], source, chain, contract, tokenID)
		items = items[:limit]
	}
	response.Data = items
	service.storeCachedJSON(request.Context(), cacheToken, response)
	writeJSON(writer, http.StatusOK, response)
}
