package httpapi

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// This query concerns canonical mint observations, not current holder balances.
func mintedNFTFilters(query url.Values) (string, []any, string, error) {
	where := "chain_id = ? AND removed = FALSE AND event_name IN ('AssetCreated', 'SeriesCreated')"
	args := []any{hoodiChainID}
	order := "block_number DESC, log_index DESC, transaction_hash DESC"
	for key, values := range query {
		if len(values) != 1 {
			return "", nil, "", errors.New("duplicate mint catalog parameter")
		}
		value := values[0]
		switch key {
		case "page", "pageSize":
			n, err := strconv.Atoi(value)
			maximum := 1000000
			if key == "pageSize" {
				maximum = 100
			}
			if err != nil || n < 1 || n > maximum || strconv.Itoa(n) != value {
				return "", nil, "", errors.New("invalid mint catalog pagination")
			}
		case "standard":
			if value == "ERC-721" {
				where += " AND event_name = ?"
				args = append(args, "AssetCreated")
			} else if value == "ERC-1155" {
				where += " AND event_name = ?"
				args = append(args, "SeriesCreated")
			} else {
				return "", nil, "", errors.New("invalid mint standard")
			}
		case "collectionAddress":
			if !validNonzeroAddress(value) {
				return "", nil, "", errors.New("invalid mint collection")
			}
			where += " AND LOWER(CASE WHEN event_name = 'SeriesCreated' THEN contract_address ELSE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.collectionAddress')) END) = ?"
			args = append(args, strings.ToLower(value))
		case "tokenId":
			if !validUint256(value) {
				return "", nil, "", errors.New("invalid mint token ID")
			}
			where += " AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenId')) = ?"
			args = append(args, value)
		case "sort":
			if value == "oldest" {
				order = "block_number ASC, log_index ASC, transaction_hash ASC"
			} else if value != "newest" {
				return "", nil, "", errors.New("invalid mint catalog sort")
			}
		default:
			return "", nil, "", errors.New("unknown mint catalog parameter")
		}
	}
	return where, args, order, nil
}
