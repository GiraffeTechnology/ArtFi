package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var marketCurrencyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)

// Only normalized public data crosses the SIN collector boundary. No raw
// provider payload, Seaport signature, wallet or execution plan is accepted.
type currentMarketListing struct {
	SchemaVersion  string `json:"schemaVersion"`
	Source         string `json:"source"`
	Chain          string `json:"chain"`
	ContractAddress string `json:"contractAddress"`
	TokenID        string `json:"tokenId"`
	CollectionSlug string `json:"collectionSlug,omitempty"`
	ObservedAtMs   int64  `json:"observedAtMs"`
	Status         string `json:"status"`
	OrderHash      string `json:"orderHash,omitempty"`
	Price          string `json:"price,omitempty"`
	Currency       string `json:"currency,omitempty"`
	Decimals       *int   `json:"decimals,omitempty"`
	ValidUntilMs   int64  `json:"validUntilMs,omitempty"`
}

func marketUint256(value string) bool {
	if !uint256Pattern.MatchString(value) {
		return false
	}
	number, ok := new(big.Int).SetString(value, 10)
	return ok && number.Sign() >= 0 && number.BitLen() <= 256
}

func validCurrentMarketListing(input currentMarketListing) bool {
	if input.SchemaVersion != "1" || input.Source != "opensea" ||
		!marketChainPattern.MatchString(input.Chain) || !addressPattern.MatchString(input.ContractAddress) ||
		input.ContractAddress != strings.ToLower(input.ContractAddress) || !marketUint256(input.TokenID) ||
		input.ObservedAtMs <= 0 || (input.CollectionSlug != "" && !marketCollectionPattern.MatchString(input.CollectionSlug)) {
		return false
	}
	if input.Status == "unavailable" || input.Status == "not-found" {
		return input.OrderHash == "" && input.Price == "" && input.Currency == "" && input.Decimals == nil && input.ValidUntilMs == 0
	}
	switch input.Status {
	case "active", "inactive", "fulfilled", "expired", "cancelled":
	default:
		return false
	}
	return txHashPattern.MatchString(input.OrderHash) && input.OrderHash == strings.ToLower(input.OrderHash) &&
		marketUint256(input.Price) && marketCurrencyPattern.MatchString(input.Currency) &&
		input.Decimals != nil && *input.Decimals >= 0 && *input.Decimals <= 36 &&
		input.ValidUntilMs > 0 && input.ValidUntilMs <= 9007199254740991 &&
		(input.Status != "active" || input.ValidUntilMs > input.ObservedAtMs)
}

func (service *rwaService) recordCurrentMarketListing(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Listing observations unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input currentMarketListing
	if decodeJSON(request, &input) != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid listing observation", "Only normalized public listing fields are accepted.")
		return
	}
	now := time.Now().UTC()
	_, approved := service.marketplaceSources[input.Source]
	if !approved || !validCurrentMarketListing(input) || input.ObservedAtMs < now.Add(-5*time.Minute).UnixMilli() || input.ObservedAtMs > now.Add(5*time.Second).UnixMilli() {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid listing observation", "The source, token identity, data or observation time is invalid.")
		return
	}
	encoded, err := json.Marshal(input)
	if err == nil {
		_, err = service.db.ExecContext(request.Context(), `
			INSERT INTO external_market_current_listings
			    (source, chain_name, contract_address, token_id, observed_at_ms, observation)
			VALUES (?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE
			    observation = IF(VALUES(observed_at_ms) > observed_at_ms, VALUES(observation), observation),
			    observed_at_ms = GREATEST(observed_at_ms, VALUES(observed_at_ms))`,
			input.Source, input.Chain, input.ContractAddress, input.TokenID, input.ObservedAtMs, encoded)
	}
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Listing observations unavailable", "The observation could not be persisted.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "recorded"})
}

func (service *rwaService) getCurrentMarketListing(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	query := request.URL.Query()
	source := query.Get("source")
	if source == "" {
		source = "opensea"
	}
	chain, contract, tokenID := query.Get("chain"), strings.ToLower(query.Get("contract")), query.Get("tokenId")
	_, approved := service.marketplaceSources[source]
	if !approved || source != "opensea" || !marketChainPattern.MatchString(chain) || !addressPattern.MatchString(contract) || !marketUint256(tokenID) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid listing identity", "Use an approved source and exact chain, contract and token ID.")
		return
	}
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Listing observations unavailable", "Durable persistence is required.")
		return
	}
	var encoded []byte
	var observedMs int64
	err := service.db.QueryRowContext(request.Context(), `
		SELECT observation, observed_at_ms FROM external_market_current_listings
		WHERE source = ? AND chain_name = ? AND contract_address = ? AND token_id = ?`,
		source, chain, contract, tokenID).Scan(&encoded, &observedMs)
	now := time.Now().UTC()
	var item *currentMarketListing
	freshness := "unknown"
	if err == nil {
		var decoded currentMarketListing
		if json.Unmarshal(encoded, &decoded) != nil || !validCurrentMarketListing(decoded) ||
			decoded.Source != source || decoded.Chain != chain || decoded.ContractAddress != contract || decoded.TokenID != tokenID || decoded.ObservedAtMs != observedMs {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Listing observations unavailable", "The stored observation does not match its token identity.")
			return
		}
		item = &decoded
		freshness = "stale"
		if recentMarketObservation(now, time.UnixMilli(observedMs)) {
			freshness = "fresh"
		}
		if item.Status == "active" && item.ValidUntilMs <= now.UnixMilli() {
			item.Status = "expired"
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Listing observations unavailable", "The observation could not be read.")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"schemaVersion": "1", "source": source, "chain": chain, "contractAddress": contract, "tokenId": tokenID,
		"runtime": true, "custody": false, "execution": "disabled", "data": item,
		"freshness": freshness, "asOf": now.Format(time.RFC3339Nano), "maxAgeSeconds": 90,
	})
}
