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
	if input.ChainID != hoodiChainID || !txHashPattern.MatchString(input.TransactionHash) ||
		!txHashPattern.MatchString(input.BlockHash) || !addressPattern.MatchString(input.ContractAddress) ||
		len(input.EventName) < 2 || len(input.EventName) > 80 || input.Payload == nil {
		writeProblem(writer, request, http.StatusUnprocessableEntity, "Invalid chain event", "Only complete Hoodi event records are accepted.")
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
	var blockHash, storedPayloadHash, contractAddress, eventName string
	var blockNumber uint64
	var confirmations uint32
	var removed bool
	err = tx.QueryRowContext(request.Context(), `
		SELECT LOWER(block_hash), LOWER(HEX(payload_hash)), LOWER(contract_address),
		       event_name, block_number, removed, confirmations
		FROM chain_events WHERE chain_id = ? AND LOWER(transaction_hash) = LOWER(?) AND log_index = ?
		FOR UPDATE`, input.ChainID, input.TransactionHash, input.LogIndex).
		Scan(&blockHash, &storedPayloadHash, &contractAddress, &eventName, &blockNumber, &removed, &confirmations)
	status := http.StatusCreated
	if err == nil {
		status = http.StatusOK
		incomingBlockHash := strings.ToLower(input.BlockHash)
		if storedPayloadHash != payloadHash || contractAddress != strings.ToLower(input.ContractAddress) || eventName != input.EventName {
			return 0, errEventConflict
		}
		// A removal identifies the stored incarnation, not another block that
		// happens to contain the same transaction/log identity. A replacement
		// may be accepted only after that incarnation has been removed.
		if (blockHash == incomingBlockHash && blockNumber != input.BlockNumber) ||
			(blockHash != incomingBlockHash && (!removed || input.Removed)) {
			return 0, errEventConflict
		}
		// Confirmation depth is monotonic only within a live incarnation.
		// Never carry the old branch's depth into a reorg replacement.
		if input.Removed {
			confirmations = 0
		} else if removed || blockHash != incomingBlockHash || input.Confirmations > confirmations {
			confirmations = input.Confirmations
		}
		_, err = tx.ExecContext(request.Context(), `
			UPDATE chain_events SET block_number = ?, block_hash = ?, removed = ?,
			confirmations = ?, confirmed = ?, observed_at = CURRENT_TIMESTAMP(6)
			WHERE chain_id = ? AND LOWER(transaction_hash) = LOWER(?) AND log_index = ?`,
			input.BlockNumber, incomingBlockHash, input.Removed, confirmations, !input.Removed && confirmations > 0,
			input.ChainID, input.TransactionHash, input.LogIndex)
		if err != nil {
			return 0, err
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		confirmations = input.Confirmations
		if input.Removed {
			confirmations = 0
		}
		_, err = tx.ExecContext(request.Context(), `
			INSERT INTO chain_events
			    (chain_id, transaction_hash, log_index, block_number, block_hash, contract_address,
			     event_name, payload, payload_hash, confirmed, removed, confirmations)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNHEX(?), ?, ?, ?)`,
			input.ChainID, strings.ToLower(input.TransactionHash), input.LogIndex,
			input.BlockNumber, strings.ToLower(input.BlockHash), strings.ToLower(input.ContractAddress),
			input.EventName, payload, payloadHash, !input.Removed && confirmations > 0, input.Removed, confirmations)
		if err != nil {
			return 0, err
		}
	} else {
		return 0, err
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
	writer.Header().Set("Cache-Control", "no-store")
	address := strings.ToLower(request.PathValue("address"))
	if !addressPattern.MatchString(address) {
		writeProblem(writer, request, http.StatusBadRequest, "Invalid address", "The portfolio address must be a 20-byte hexadecimal Ethereum address.")
		return
	}
	response := portfolioResponse{
		Address: address, ChainID: hoodiChainID, Network: "hoodi",
		Positions: []portfolioPosition{}, Transactions: []portfolioEntry{},
		Offers: []map[string]any{}, Notifications: []map[string]any{},
	}
	if service.db == nil {
		writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "Durable chain records are unavailable; an empty portfolio is not inferred.")
		return
	}
	rows, err := service.db.QueryContext(request.Context(), `
		SELECT d.asset_token, d.symbol, d.direction, d.amount,
		       DATE_FORMAT(e.observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM portfolio_deltas d JOIN chain_events e
		  ON e.chain_id = d.chain_id AND e.transaction_hash = d.transaction_hash AND e.log_index = d.log_index
		WHERE d.chain_id = ? AND d.owner_address = ? AND d.removed = FALSE
		  AND e.removed = FALSE AND e.confirmed = TRUE AND e.confirmations > 0
		  AND e.event_name = 'Transfer' AND LOWER(e.contract_address) = LOWER(d.asset_token)
		ORDER BY e.block_number, e.log_index, d.transaction_hash, d.direction`, hoodiChainID, address)
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
		if !ok || !marketUint256(amount) || !addressPattern.MatchString(token) || (direction != "debit" && direction != "credit") {
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
		if balances[token].Sign() < 0 || balances[token].BitLen() > 256 {
			writeProblem(writer, request, http.StatusServiceUnavailable, "Portfolio unavailable", "The retained transfer projection is incomplete or inconsistent; no wallet balance is inferred.")
			return
		}
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
		LIMIT 100`, hoodiChainID, address, address, address, address, address)
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
	writeJSON(writer, http.StatusOK, response)
}
