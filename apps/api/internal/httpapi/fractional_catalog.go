package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type fractionalCatalogCursor struct {
	Version int    `json:"version"`
	ChainID int    `json:"chainId"`
	Factory string `json:"factory"`
	EventID string `json:"eventId"`
}

type fractionalCatalogRecord struct {
	EventID         string `json:"eventId"`
	VaultAddress    string `json:"vaultAddress"`
	Collection      string `json:"collectionAddress"`
	TokenID         string `json:"tokenId"`
	VaultName       string `json:"vaultName"`
	FractionToken   string `json:"fractionTokenAddress"`
	Supply          string `json:"supply"`
	Recipient       string `json:"issuanceRecipient"`
	TransactionHash string `json:"transactionHash"`
	BlockHash       string `json:"blockHash"`
	BlockNumber     string `json:"blockNumber"`
	LogIndex        uint32 `json:"logIndex"`
	ObservedAt      string `json:"observedAt"`
}

func (service *rwaService) getFractionalCatalog(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	factory := strings.ToLower(service.config.vaultFactoryAddress)
	if service.db == nil || !fractionalCatalogAddress(factory) {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Fractional catalog unavailable", "Durable chain events and a configured VaultFactory are required; no fixture fallback is used.")
		return
	}
	limit := 20
	if value := request.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid page size", "Limit must be between 1 and 100.")
			return
		}
		limit = parsed
	}
	before := ""
	if encoded := request.URL.Query().Get("cursor"); encoded != "" {
		if len(encoded) > 512 {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid cursor", "Use the cursor returned for this fractional catalog.")
			return
		}
		var cursor fractionalCatalogCursor
		decoded, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil || json.Unmarshal(decoded, &cursor) != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid cursor", "Use the cursor returned for this fractional catalog.")
			return
		}
		canonical, _ := json.Marshal(cursor)
		id, idErr := strconv.ParseUint(cursor.EventID, 10, 64)
		if cursor.Version != 1 || cursor.ChainID != hoodiChainID || cursor.Factory != factory || idErr != nil || id == 0 || strconv.FormatUint(id, 10) != cursor.EventID || base64.RawURLEncoding.EncodeToString(canonical) != encoded {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid cursor", "The cursor does not match this catalog scope.")
			return
		}
		before = cursor.EventID
	}

	// Link issuance to a confirmed, non-removed creation from the configured
	// factory. Never infer a fund from a prepared DB intent or an arbitrary token.
	rows, err := service.db.QueryContext(request.Context(), `
		WITH origins AS (
			SELECT payload, block_number, block_hash, log_index,
			       COUNT(*) OVER (PARTITION BY LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.vault')))) AS origin_count
			FROM chain_events
			WHERE chain_id = ? AND LOWER(contract_address) = ?
			  AND event_name = 'VaultCreated' AND confirmed = TRUE
			  AND confirmations > 0 AND removed = FALSE
		), issuances AS (
			SELECT chain_events.*, COUNT(*) OVER (PARTITION BY LOWER(contract_address)) AS issuance_count
			FROM chain_events
			WHERE chain_id = ? AND event_name = 'Fractionalized'
			  AND confirmed = TRUE AND confirmations > 0 AND removed = FALSE
		)
		SELECT CAST(f.event_id AS CHAR), LOWER(f.contract_address),
		       JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.collection')),
		       JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.tokenId')),
		       JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.vaultName')),
		       JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.token')),
		       JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.supply')),
		       JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.recipient')),
		       LOWER(f.transaction_hash), LOWER(f.block_hash), CAST(f.block_number AS CHAR),
		       f.log_index, DATE_FORMAT(f.observed_at, '%Y-%m-%dT%H:%i:%s.%fZ'), o.origin_count, f.issuance_count
		FROM issuances f
		JOIN origins o ON LOWER(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.vault'))) = LOWER(f.contract_address)
		WHERE (o.block_number < f.block_number OR (o.block_number = f.block_number AND LOWER(o.block_hash) = LOWER(f.block_hash) AND o.log_index < f.log_index))
		  AND (? = '' OR f.event_id < CAST(? AS UNSIGNED))
		ORDER BY f.event_id DESC LIMIT ?`, hoodiChainID, factory, hoodiChainID, before, before, limit+1)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Fractional catalog unavailable", "Indexed issuance records could not be read.")
		return
	}
	defer rows.Close()
	items := make([]fractionalCatalogRecord, 0, limit+1)
	seen := make(map[string]bool)
	for rows.Next() {
		var item fractionalCatalogRecord
		var origins, issuances uint64
		if err := rows.Scan(&item.EventID, &item.VaultAddress, &item.Collection, &item.TokenID, &item.VaultName, &item.FractionToken, &item.Supply, &item.Recipient, &item.TransactionHash, &item.BlockHash, &item.BlockNumber, &item.LogIndex, &item.ObservedAt, &origins, &issuances); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Fractional catalog unavailable", "An indexed issuance record could not be decoded.")
			return
		}
		item.Collection = strings.ToLower(item.Collection)
		item.FractionToken = strings.ToLower(item.FractionToken)
		item.Recipient = strings.ToLower(item.Recipient)
		if origins != 1 || issuances != 1 || seen[item.VaultAddress] || !fractionalCatalogAddress(item.VaultAddress) || !fractionalCatalogAddress(item.Collection) || !fractionalCatalogAddress(item.FractionToken) || !fractionalCatalogAddress(item.Recipient) || !marketUint256(item.TokenID) || !marketUint256(item.Supply) || item.Supply == "0" || len(item.VaultName) < 2 || len(item.VaultName) > 80 || !txHashPattern.MatchString(item.TransactionHash) || !txHashPattern.MatchString(item.BlockHash) {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Fractional catalog unavailable", "Indexed issuance evidence is invalid or ambiguous.")
			return
		}
		seen[item.VaultAddress] = true
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Fractional catalog unavailable", "The indexed issuance query was interrupted.")
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		payload, _ := json.Marshal(fractionalCatalogCursor{Version: 1, ChainID: hoodiChainID, Factory: factory, EventID: items[len(items)-1].EventID})
		next = base64.RawURLEncoding.EncodeToString(payload)
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"data": items, "nextCursor": next, "chainId": hoodiChainID,
		"factoryAddress": factory, "runtime": true, "readOnly": true,
		"evidence": "indexed-confirmed-events",
	})
}

func fractionalCatalogAddress(value string) bool {
	return addressPattern.MatchString(value) && !strings.EqualFold(value, "0x0000000000000000000000000000000000000000")
}
