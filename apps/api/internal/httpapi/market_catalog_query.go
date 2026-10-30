package httpapi

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type marketCatalogQuery struct {
	Page          int
	PageSize      int
	Q             string
	ListingStatus string
	Sort          string
}

func parseMarketCatalogQuery(values url.Values) (marketCatalogQuery, error) {
	query := marketCatalogQuery{Page: 1, PageSize: 20, ListingStatus: "all", Sort: "newest"}
	invalid := errors.New("use a valid catalog page, page size, search, listing status and sort")
	for name, target := range map[string]*int{"page": &query.Page, "pageSize": &query.PageSize} {
		if raw := values.Get(name); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < 1 || strconv.Itoa(value) != raw {
				return query, invalid
			}
			*target = value
		}
	}
	if query.Page > 1000000 || query.PageSize > 100 {
		return query, invalid
	}
	query.Q = strings.TrimSpace(values.Get("q"))
	if !utf8.ValidString(query.Q) || utf8.RuneCountInString(query.Q) > 100 || strings.IndexFunc(query.Q, unicode.IsControl) >= 0 {
		return query, invalid
	}
	if value := values.Get("listingStatus"); value != "" {
		query.ListingStatus = value
	}
	if value := values.Get("sort"); value != "" {
		query.Sort = value
	}
	if query.ListingStatus != "all" && query.ListingStatus != "active" && query.ListingStatus != "inactive" {
		return query, invalid
	}
	if query.Sort != "newest" && query.Sort != "oldest" && query.Sort != "token" {
		return query, invalid
	}
	for _, name := range []string{"page", "pageSize", "q", "listingStatus", "sort", "contract", "source"} {
		if len(values[name]) > 1 {
			return query, invalid
		}
	}
	return query, nil
}

// Filter values are bound parameters. SQL identifiers and order clauses only
// come from these fixed strings, never from a query-string fragment.
func (query marketCatalogQuery) filterSQL() (string, []any) {
	where := " WHERE 1 = 1"
	args := make([]any, 0)
	if query.Q != "" {
		literal := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(query.Q)
		pattern := "%" + literal + "%"
		where += " AND (LOWER(collection_slug) LIKE LOWER(?) ESCAPE '!' OR LOWER(contract_address) LIKE LOWER(?) ESCAPE '!' OR token_id LIKE ? ESCAPE '!' OR LOWER(chain_name) LIKE LOWER(?) ESCAPE '!')"
		args = append(args, pattern, pattern, pattern, pattern)
	}
	if query.ListingStatus == "active" {
		where += " AND (order_status = 'active' AND order_hash <> '')"
	}
	if query.ListingStatus == "inactive" {
		where += " AND NOT (order_status = 'active' AND order_hash <> '')"
	}
	return where, args
}

func (query marketCatalogQuery) orderSQL() string {
	if query.Sort == "token" {
		// Canonical decimal token IDs can occupy 78 digits: no FLOAT or MySQL
		// DECIMAL(65) cast may round/truncate them.
		return " ORDER BY chain_name, contract_address, CHAR_LENGTH(token_id), token_id"
	}
	direction := " DESC"
	if query.Sort == "oldest" {
		direction = " ASC"
	}
	return " ORDER BY event_timestamp" + direction + ", chain_name, contract_address, CHAR_LENGTH(token_id), token_id"
}
