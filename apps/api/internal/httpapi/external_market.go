package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxMarketSnapshotEventBytes = 1 << 20
	marketSnapshotIdleTimeout   = 15 * time.Second
)

type marketSnapshotProgressReader struct {
	reader     io.Reader
	controller *http.ResponseController
	now        func() time.Time
}

func newMarketSnapshotProgressReader(
	writer http.ResponseWriter,
	reader io.Reader,
	now func() time.Time,
) (*marketSnapshotProgressReader, error) {
	progressReader := &marketSnapshotProgressReader{
		reader:     reader,
		controller: http.NewResponseController(writer),
		now:        now,
	}
	if err := progressReader.extendDeadlines(); err != nil {
		return nil, err
	}
	return progressReader, nil
}

func (reader *marketSnapshotProgressReader) Read(buffer []byte) (int, error) {
	read, err := reader.reader.Read(buffer)
	if read > 0 {
		if deadlineErr := reader.extendDeadlines(); deadlineErr != nil {
			return read, deadlineErr
		}
	}
	return read, err
}

func (reader *marketSnapshotProgressReader) extendDeadlines() error {
	deadline := reader.now().Add(marketSnapshotIdleTimeout)
	if err := reader.controller.SetReadDeadline(deadline); err != nil {
		return err
	}
	return reader.controller.SetWriteDeadline(deadline)
}

var (
	marketSourcePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	marketChainPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	marketEntityPattern = regexp.MustCompile(`^[A-Za-z0-9:/_.-]{1,196}$`)
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
}

type marketActivityResponse struct {
	Data          []marketActivity `json:"data"`
	SchemaVersion string           `json:"schemaVersion"`
	Source        string           `json:"source"`
	Execution     string           `json:"execution"`
	Custody       bool             `json:"custody"`
}

type preparedMarketEvent struct {
	input          marketEventRequest
	eventID        string
	payload        []byte
	payloadHash    []byte
	eventTimestamp time.Time
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
	if !service.authorizeMarketIndexer(request) {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input marketEventRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid market event", err.Error())
		return
	}
	prepared, err := service.prepareMarketEvent(input)
	if err != nil {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market event", err.Error())
		return
	}
	status, err := service.persistMarketEvent(request, prepared)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The normalized event could not be stored durably.")
		return
	}
	service.bumpCacheNamespace(request.Context(), "market")
	writeJSON(writer, status, map[string]any{"eventId": prepared.eventID, "status": "mirrored"})
}

func (service *rwaService) ingestMarketSnapshot(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	if !service.authorizeMarketIndexer(request) {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	if strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0]) != "application/x-ndjson" {
		writeProblem(writer, request, http.StatusUnsupportedMediaType, "Invalid market snapshot", "Market snapshots must use application/x-ndjson.")
		return
	}
	snapshotBody, err := newMarketSnapshotProgressReader(writer, request.Body, service.now)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The snapshot connection cannot enforce a bounded idle timeout.")
		return
	}
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The atomic snapshot transaction could not be started.")
		return
	}
	defer tx.Rollback()
	scanner := bufio.NewScanner(snapshotBody)
	scanner.Buffer(make([]byte, 64<<10), maxMarketSnapshotEventBytes)
	count := 0
	created := 0
	for scanner.Scan() {
		if err := snapshotBody.extendDeadlines(); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The snapshot connection cannot refresh its bounded idle timeout.")
			return
		}
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		count++
		input, decodeErr := decodeMarketSnapshotEvent(line)
		if decodeErr != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid market snapshot", decodeErr.Error())
			return
		}
		prepared, prepareErr := service.prepareMarketEvent(input)
		if prepareErr != nil {
			writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid market snapshot", prepareErr.Error())
			return
		}
		inserted, persistErr := service.persistMarketEventTx(request.Context(), tx, prepared)
		if persistErr != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The atomic snapshot could not be stored durably.")
			return
		}
		if err := snapshotBody.extendDeadlines(); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The snapshot connection cannot refresh its bounded idle timeout.")
			return
		}
		if inserted {
			created++
		}
	}
	if err := scanner.Err(); err != nil {
		writeProblem(writer, request, http.StatusRequestEntityTooLarge, "Invalid market snapshot", "The NDJSON snapshot stream is invalid or exceeds the event size limit.")
		return
	}
	if err := snapshotBody.extendDeadlines(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The snapshot connection cannot refresh its bounded idle timeout.")
		return
	}
	if err := tx.Commit(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The atomic snapshot could not be committed.")
		return
	}
	if err := snapshotBody.extendDeadlines(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Market mirror unavailable", "The snapshot connection cannot refresh its bounded idle timeout.")
		return
	}
	service.bumpCacheNamespace(request.Context(), "market")
	writeJSON(writer, http.StatusCreated, map[string]any{
		"status": "mirrored", "events": count, "created": created,
	})
}

func (service *rwaService) authorizeMarketIndexer(request *http.Request) bool {
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	return subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) == 1
}

func decodeMarketSnapshotEvent(line []byte) (marketEventRequest, error) {
	var input marketEventRequest
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return marketEventRequest{}, fmt.Errorf("snapshot lines must be valid market events with known fields")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return marketEventRequest{}, fmt.Errorf("snapshot lines must contain exactly one market event")
	}
	return input, nil
}

func (service *rwaService) prepareMarketEvent(input marketEventRequest) (preparedMarketEvent, error) {
	input.Source = strings.ToLower(strings.TrimSpace(input.Source))
	input.Chain = strings.ToLower(strings.TrimSpace(input.Chain))
	input.EventType = strings.ToLower(strings.TrimSpace(input.EventType))
	input.EventFamily = strings.ToLower(strings.TrimSpace(input.EventFamily))
	if err := service.validateMarketEvent(input); err != nil {
		return preparedMarketEvent{}, err
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return preparedMarketEvent{}, fmt.Errorf("the source payload is not valid JSON")
	}
	eventTimestamp, err := time.Parse(time.RFC3339, input.EventTimestamp)
	if err != nil {
		return preparedMarketEvent{}, err
	}
	payloadHash := sha256.Sum256(payload)
	eventIDMaterial := fmt.Sprintf("%s|%s|%s|%s|%d|%s|%s", input.SchemaVersion, input.Source, input.EventFamily, input.EntityKey, input.Version, input.EventType, input.EventTimestamp)
	eventID := sha256.Sum256([]byte(eventIDMaterial))
	return preparedMarketEvent{
		input: input, eventID: hex.EncodeToString(eventID[:]), payload: payload,
		payloadHash: payloadHash[:], eventTimestamp: eventTimestamp,
	}, nil
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
	if input.TokenID != "" && !uint256Pattern.MatchString(input.TokenID) {
		return fmt.Errorf("token id must be an unsigned 256-bit decimal value")
	}
	if input.Price != "" && !uint256Pattern.MatchString(input.Price) {
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

func (service *rwaService) persistMarketEvent(request *http.Request, prepared preparedMarketEvent) (int, error) {
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	inserted, err := service.persistMarketEventTx(request.Context(), tx, prepared)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if !inserted {
		return http.StatusOK, nil
	}
	return http.StatusCreated, nil
}

func (service *rwaService) persistMarketEventTx(ctx context.Context, tx *sql.Tx, prepared preparedMarketEvent) (bool, error) {
	input := prepared.input
	result, err := tx.ExecContext(ctx, `
		INSERT IGNORE INTO external_market_events
		    (event_id, schema_version, source, event_type, event_family, entity_key, event_version,
		     chain_name, collection_slug, order_hash, transaction_hash, contract_address, token_id,
		     maker_address, price, payment_token_address, payment_symbol, marketplace_url,
		     event_timestamp, payload, payload_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
		        NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
		        NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?)`,
		prepared.eventID, input.SchemaVersion, input.Source, input.EventType, input.EventFamily, input.EntityKey,
		input.Version, input.Chain, input.CollectionSlug, strings.ToLower(input.OrderHash),
		strings.ToLower(input.TransactionHash), strings.ToLower(input.ContractAddress), input.TokenID,
		strings.ToLower(input.MakerAddress), input.Price, strings.ToLower(input.PaymentTokenAddress),
		input.PaymentSymbol, input.MarketplaceURL, prepared.eventTimestamp, prepared.payload, prepared.payloadHash)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if input.EventFamily == "order" && input.OrderHash != "" {
		status := marketOrderStatus(input.EventType)
		_, err = tx.ExecContext(ctx, `
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
			input.PaymentSymbol, input.MarketplaceURL, prepared.eventTimestamp, prepared.payload)
		if err != nil {
			return false, err
		}
	}
	if input.EventFamily == "sale" && input.OrderHash != "" {
		_, err = tx.ExecContext(ctx, `
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
			input.PaymentSymbol, input.MarketplaceURL, prepared.eventTimestamp, prepared.eventTimestamp,
			strings.ToLower(input.TransactionHash), prepared.payload)
		if err != nil {
			return false, err
		}
	}
	if err := reconcileMarketIntents(tx, input, prepared.eventTimestamp); err != nil {
		return false, err
	}
	return rows > 0, nil
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
		       DATE_FORMAT(event_timestamp, '%Y-%m-%dT%H:%i:%s.%fZ'), payload
		FROM external_market_events WHERE source = ?`
	args := []any{source}
	if contract != "" {
		query += " AND contract_address = ?"
		args = append(args, contract)
	}
	query += " ORDER BY event_timestamp DESC, received_at DESC LIMIT ?"
	args = append(args, limit)
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
	response.Data = items
	service.storeCachedJSON(request.Context(), cacheToken, response)
	writeJSON(writer, http.StatusOK, response)
}
