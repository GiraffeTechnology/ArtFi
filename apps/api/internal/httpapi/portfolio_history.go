package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const portfolioHistoryPageSize = 10
const portfolioHistoryPageLimit = 1000000

var portfolioHistoryEventPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{1,79}$`)
var portfolioHistoryPagePattern = regexp.MustCompile(`^[1-9][0-9]{0,6}$`)

type portfolioHistoryFilter struct {
	Status          string `json:"status"`
	EventName       string `json:"eventName"`
	ContractAddress string `json:"contractAddress"`
	Order           string `json:"order"`
	Page            int    `json:"page"`
}

type portfolioHistoryPage struct {
	Address  string                 `json:"address"`
	ChainID  int                    `json:"chainId"`
	Scope    string                 `json:"scope"`
	Filters  portfolioHistoryFilter `json:"filters"`
	PageSize int                    `json:"pageSize"`
	Total    uint64                 `json:"total"`
	Data     []portfolioEntry       `json:"data"`
}

func parsePortfolioHistoryFilter(query url.Values) (portfolioHistoryFilter, error) {
	filter := portfolioHistoryFilter{Status: "all", Order: "newest", Page: 1}
	invalid := errors.New("invalid indexed history filters")
	for key, values := range query {
		if len(values) != 1 || values[0] == "" {
			return filter, invalid
		}
		switch key {
		case "status":
			filter.Status = values[0]
		case "eventName":
			filter.EventName = values[0]
		case "contractAddress":
			filter.ContractAddress = strings.ToLower(values[0])
		case "order":
			filter.Order = values[0]
		case "page":
			if !portfolioHistoryPagePattern.MatchString(values[0]) {
				return filter, invalid
			}
			page, err := strconv.Atoi(values[0])
			if err != nil || page > portfolioHistoryPageLimit {
				return filter, invalid
			}
			filter.Page = page
		default:
			return filter, invalid
		}
	}
	if filter.Status != "all" && filter.Status != "pending" && filter.Status != "confirmed" && filter.Status != "removed" {
		return filter, invalid
	}
	if filter.Order != "newest" && filter.Order != "oldest" {
		return filter, invalid
	}
	if filter.EventName != "" && !portfolioHistoryEventPattern.MatchString(filter.EventName) {
		return filter, invalid
	}
	if filter.ContractAddress != "" && !addressPattern.MatchString(filter.ContractAddress) {
		return filter, invalid
	}
	return filter, nil
}

// Reuse the original participant predicate and session authority. A filter never
// selects another owner, chain, provider or credential.
func protectedPortfolioHistory(service *rwaService, auth *userAuthService) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
		defer cancel()
		request = request.WithContext(ctx)
		address := strings.ToLower(request.PathValue("address"))
		if !addressPattern.MatchString(address) {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid address", "A valid wallet address is required.")
			return
		}
		if err := auth.requireSeller(request, address, hoodiChainID); err != nil {
			auth.writeError(writer, request, err)
			return
		}
		query, err := url.ParseQuery(request.URL.RawQuery)
		if err != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid history filters", "The history query could not be decoded.")
			return
		}
		filter, err := parsePortfolioHistoryFilter(query)
		if err != nil {
			writeProblem(writer, request, http.StatusBadRequest, "Invalid history filters", "Only supported history status, event, contract, order and page filters are accepted.")
			return
		}
		page, err := readPortfolioHistory(ctx, service.db, address, filter)
		if err != nil {
			writeProblem(writer, request, http.StatusServiceUnavailable, "History unavailable", "The indexed wallet history could not be completed.")
			return
		}
		writeJSON(writer, http.StatusOK, page)
	}
}

func portfolioHistoryPredicate(address string, filter portfolioHistoryFilter) (string, []any) {
	wallet, args := portfolioWalletPredicate("", address)
	where := "chain_id = ? AND (" + wallet + ")"
	args = append([]any{hoodiChainID}, args...)
	switch filter.Status {
	case "pending":
		where += " AND removed = FALSE AND confirmed = FALSE"
	case "confirmed":
		where += " AND removed = FALSE AND confirmed = TRUE"
	case "removed":
		where += " AND removed = TRUE"
	}
	if filter.EventName != "" {
		where += " AND BINARY event_name = ?"
		args = append(args, filter.EventName)
	}
	if filter.ContractAddress != "" {
		where += " AND contract_address = ?"
		args = append(args, filter.ContractAddress)
	}
	return where, args
}

func readPortfolioHistory(ctx context.Context, db persistenceDB, address string, filter portfolioHistoryFilter) (portfolioHistoryPage, error) {
	page := portfolioHistoryPage{Address: address, ChainID: hoodiChainID, Scope: "indexed_chain_events", Filters: filter, PageSize: portfolioHistoryPageSize, Data: []portfolioEntry{}}
	if db == nil {
		return page, errors.New("indexed history persistence unavailable")
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	where, args := portfolioHistoryPredicate(address, filter)
	// Count and rows belong to this one read-only snapshot. Subsequent pages are
	// fresh reads: indexing and reorgs can change their contents and totals.
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM chain_events WHERE "+where, args...).Scan(&page.Total); err != nil {
		return page, err
	}
	direction := "DESC"
	if filter.Order == "oldest" {
		direction = "ASC"
	}
	order := " ORDER BY block_number " + direction + ", log_index " + direction + ", transaction_hash " + direction
	query := `SELECT LOWER(transaction_hash), log_index, LOWER(contract_address), event_name, block_number,
		CASE WHEN removed THEN 'removed' WHEN confirmed THEN 'confirmed' ELSE 'pending' END,
		DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM chain_events WHERE ` + where + order + " LIMIT ? OFFSET ?"
	rows, err := tx.QueryContext(ctx, query, append(args, portfolioHistoryPageSize, (filter.Page-1)*portfolioHistoryPageSize)...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var entry portfolioEntry
		if err := rows.Scan(&entry.TransactionHash, &entry.LogIndex, &entry.ContractAddress, &entry.EventName, &entry.BlockNumber, &entry.Status, &entry.ObservedAt); err != nil {
			return page, err
		}
		entry.ID = portfolioEventID(hoodiChainID, entry.TransactionHash, entry.LogIndex)
		page.Data = append(page.Data, entry)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if err := rows.Close(); err != nil {
		return page, err
	}
	if err := tx.Commit(); err != nil {
		return page, err
	}
	return page, nil
}
