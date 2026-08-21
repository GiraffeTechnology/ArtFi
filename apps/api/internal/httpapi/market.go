package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"sort"
	"strings"
)

type chainEventRequest struct {
	ChainID         int            `json:"chainId"`
	TransactionHash string         `json:"transactionHash"`
	LogIndex        uint32         `json:"logIndex"`
	BlockNumber     uint64         `json:"blockNumber"`
	BlockHash       string         `json:"blockHash"`
	ContractAddress string         `json:"contractAddress"`
	EventName       string         `json:"eventName"`
	Payload         map[string]any `json:"payload"`
	Removed         bool           `json:"removed"`
	Confirmations   uint32         `json:"confirmations"`
}

type portfolioPosition struct {
	AssetToken string `json:"assetToken"`
	Symbol     string `json:"symbol"`
	Balance    string `json:"balance"`
	UpdatedAt  string `json:"updatedAt"`
}

type portfolioEntry struct {
	TransactionHash string `json:"transactionHash"`
	EventName       string `json:"eventName"`
	BlockNumber     uint64 `json:"blockNumber"`
	Status          string `json:"status"`
	ObservedAt      string `json:"observedAt"`
}

type portfolioResponse struct {
	Address       string              `json:"address"`
	ChainID       int                 `json:"chainId"`
	Network       string              `json:"network"`
	Positions     []portfolioPosition `json:"positions"`
	Transactions  []portfolioEntry    `json:"transactions"`
	Offers        []map[string]any    `json:"offers"`
	Notifications []map[string]any    `json:"notifications"`
}

var errEventConflict = errors.New("the canonical event identity conflicts with stored payload or block state")

func (service *rwaService) ingestChainEvent(writer http.ResponseWriter, request *http.Request) {
	if service.db == nil || !service.indexerEnabled {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Indexer unavailable", "Durable persistence and an indexer credential are required.")
		return
	}
	provided := sha256.Sum256([]byte(request.Header.Get("X-Indexer-Key")))
	if subtle.ConstantTimeCompare(provided[:], service.indexerKeyHash[:]) != 1 {
		writeProblem(writer, request, http.StatusUnauthorized, "Indexer authentication failed", "A valid indexer credential is required.")
		return
	}
	var input chainEventRequest
	if err := decodeJSON(request, &input); err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid chain event", err.Error())
		return
	}
	if input.ChainID != sepoliaChainID || !txHashPattern.MatchString(input.TransactionHash) ||
		!txHashPattern.MatchString(input.BlockHash) || !addressPattern.MatchString(input.ContractAddress) ||
		len(input.EventName) < 2 || len(input.EventName) > 80 || input.Payload == nil {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid chain event", "Only complete Sepolia event records are accepted.")
		return
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid event payload", err.Error())
		return
	}
	payloadHash := sha256.Sum256(payload)
	status, err := service.persistChainEvent(request, input, payload, hex.EncodeToString(payloadHash[:]))
	if err != nil {
		if errors.Is(err, errEventConflict) {
			writeProblem(writer, request, http.StatusConflict, "Chain event conflict", err.Error())
			return
		}
		writeProblem(writer, request, http.StatusServiceUnavailable, "Indexer persistence unavailable", "The event could not be stored durably.")
		return
	}
	service.invalidatePortfolioCache(request.Context(), input)
	writeJSON(writer, status, map[string]any{"status": "recorded", "removed": input.Removed})
}

func (service *rwaService) persistChainEvent(request *http.Request, input chainEventRequest, payload []byte, payloadHash string) (int, error) {
	tx, err := service.db.BeginTx(request.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(request.Context(), `
		SELECT LOWER(block_hash), LOWER(HEX(payload_hash)), removed
		FROM chain_events WHERE chain_id = ? AND LOWER(transaction_hash) = LOWER(?) AND log_index = ?`,
		input.ChainID, input.TransactionHash, input.LogIndex)
	if err != nil {
		return 0, err
	}
	status := http.StatusCreated
	if rows.Next() {
		status = http.StatusOK
		var blockHash, storedPayloadHash string
		var removed bool
		if err := rows.Scan(&blockHash, &storedPayloadHash, &removed); err != nil {
			rows.Close()
			return 0, err
		}
		incomingBlockHash := strings.ToLower(input.BlockHash)
		if storedPayloadHash != payloadHash || (blockHash != incomingBlockHash && !removed && !input.Removed) {
			rows.Close()
			return 0, errEventConflict
		}
		rows.Close()
		_, err = tx.ExecContext(request.Context(), `
			UPDATE chain_events SET block_number = ?, block_hash = ?, removed = ?,
			confirmations = GREATEST(confirmations, ?), observed_at = CURRENT_TIMESTAMP(6)
			WHERE chain_id = ? AND LOWER(transaction_hash) = LOWER(?) AND log_index = ?`,
			input.BlockNumber, incomingBlockHash, input.Removed, input.Confirmations,
			input.ChainID, input.TransactionHash, input.LogIndex)
		if err != nil {
			return 0, err
		}
	} else {
		if err := rows.Err(); err != nil {
			rows.Close()
			return 0, err
		}
		rows.Close()
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO chain_events
			    (chain_id, transaction_hash, log_index, block_number, block_hash, contract_address,
			     event_name, payload, payload_hash, confirmed, removed, confirmations)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNHEX(?), ?, ?, ?)`,
			input.ChainID, strings.ToLower(input.TransactionHash), input.LogIndex,
			input.BlockNumber, strings.ToLower(input.BlockHash), strings.ToLower(input.ContractAddress),
			input.EventName, payload, payloadHash, input.Confirmations > 0, input.Removed, input.Confirmations)
		if err != nil {
			return 0, err
		}
	}
	if err := projectTransfer(request, tx, input); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return status, nil
}

func projectTransfer(request *http.Request, tx *sql.Tx, input chainEventRequest) error {
	if input.EventName != "Transfer" {
		return nil
	}
	from, fromOK := input.Payload["from"].(string)
	to, toOK := input.Payload["to"].(string)
	value, valueOK := input.Payload["value"].(string)
	symbol, symbolOK := input.Payload["symbol"].(string)
	if !fromOK || !toOK || !valueOK || !symbolOK || !addressPattern.MatchString(from) ||
		!addressPattern.MatchString(to) || !uint256Pattern.MatchString(value) || len(symbol) < 1 || len(symbol) > 12 {
		return errEventConflict
	}
	zero := "0x0000000000000000000000000000000000000000"
	for _, delta := range []struct {
		owner     string
		direction string
	}{
		{strings.ToLower(from), "debit"},
		{strings.ToLower(to), "credit"},
	} {
		if delta.owner == zero {
			continue
		}
		_, err := tx.ExecContext(request.Context(), `
			INSERT INTO portfolio_deltas
			    (chain_id, transaction_hash, log_index, owner_address, asset_token, symbol,
			     direction, amount, removed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON DUPLICATE KEY UPDATE removed = VALUES(removed), observed_at = CURRENT_TIMESTAMP(6)`,
			input.ChainID, strings.ToLower(input.TransactionHash), input.LogIndex, delta.owner,
			strings.ToLower(input.ContractAddress), symbol, delta.direction, value, input.Removed)
		if err != nil {
			return err
		}
	}
	return nil
}

func (service *rwaService) getPortfolio(writer http.ResponseWriter, request *http.Request) {
	address := strings.ToLower(request.PathValue("address"))
	if !addressPattern.MatchString(address) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid address", "The portfolio address must be a 20-byte hexadecimal Ethereum address.")
		return
	}
	response := portfolioResponse{
		Address: address, ChainID: sepoliaChainID, Network: "sepolia",
		Positions: []portfolioPosition{}, Transactions: []portfolioEntry{},
		Offers: []map[string]any{}, Notifications: []map[string]any{},
	}
	if service.db == nil {
		writeJSON(writer, http.StatusOK, response)
		return
	}
	cacheToken, cacheHit := service.loadCachedJSON(request.Context(), "portfolio:"+address, "", &response)
	if cacheHit {
		writeJSON(writer, http.StatusOK, response)
		return
	}
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT asset_token, symbol, direction, amount,
		       DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM portfolio_deltas WHERE owner_address = ? AND removed = FALSE
		ORDER BY observed_at, transaction_hash, log_index`, address)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio read model could not be queried.")
		return
	}
	defer rows.Close()
	positions := make(map[string]*portfolioPosition)
	balances := make(map[string]*big.Int)
	for rows.Next() {
		var token, symbol, direction, amount, observedAt string
		if err := rows.Scan(&token, &symbol, &direction, &amount, &observedAt); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio read model could not be decoded.")
			return
		}
		value, ok := new(big.Int).SetString(amount, 10)
		if !ok {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio read model contains an invalid amount.")
			return
		}
		if balances[token] == nil {
			balances[token] = new(big.Int)
			positions[token] = &portfolioPosition{AssetToken: token, Symbol: symbol}
		}
		if direction == "debit" {
			balances[token].Sub(balances[token], value)
		} else {
			balances[token].Add(balances[token], value)
		}
		positions[token].UpdatedAt = observedAt
	}
	if err := rows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio read model could not be completed.")
		return
	}
	tokens := make([]string, 0, len(positions))
	for token := range positions {
		tokens = append(tokens, token)
	}
	sort.Strings(tokens)
	for _, token := range tokens {
		position := positions[token]
		position.Balance = balances[token].String()
		response.Positions = append(response.Positions, *position)
	}
	transactionRows, err := service.db.QueryContext(request.Context(), `
		SELECT LOWER(transaction_hash), event_name, block_number,
		       CASE WHEN removed THEN 'removed'
		            WHEN confirmed THEN 'confirmed' ELSE 'pending' END,
		       DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM chain_events
		WHERE chain_id = ? AND (
		  LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.from'))) = ? OR
		  LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.to'))) = ? OR
		  LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.owner'))) = ? OR
		  LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.recipient'))) = ? OR
		  LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.distributionWallet'))) = ?
		)
		ORDER BY block_number DESC, log_index DESC
		LIMIT 100`, sepoliaChainID, address, address, address, address, address)
	if err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio transaction history could not be queried.")
		return
	}
	defer transactionRows.Close()
	for transactionRows.Next() {
		var entry portfolioEntry
		if err := transactionRows.Scan(
			&entry.TransactionHash,
			&entry.EventName,
			&entry.BlockNumber,
			&entry.Status,
			&entry.ObservedAt,
		); err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio transaction history could not be decoded.")
			return
		}
		response.Transactions = append(response.Transactions, entry)
	}
	if err := transactionRows.Err(); err != nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The portfolio transaction history was interrupted.")
		return
	}
	service.storeCachedJSON(request.Context(), cacheToken, response)
	writeJSON(writer, http.StatusOK, response)
}
