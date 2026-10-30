package httpapi

import (
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestMarketCatalogQueryDefaultsAndLiteralSearch(t *testing.T) {
	query, err := parseMarketCatalogQuery(url.Values{"q": {"  Ink%_!  "}})
	if err != nil || query.Page != 1 || query.PageSize != 20 || query.Q != "Ink%_!" || query.Sort != "newest" || query.ListingStatus != "all" {
		t.Fatalf("unexpected query: %+v %v", query, err)
	}
	where, args := query.filterSQL()
	if strings.Contains(where, query.Q) || strings.Count(where, "?") != 4 || !reflect.DeepEqual(args, []any{"%Ink!%!_!!%", "%Ink!%!_!!%", "%Ink!%!_!!%", "%Ink!%!_!!%"}) {
		t.Fatalf("search is not literal bound parameters: %s %#v", where, args)
	}
}

func TestMarketCatalogQueryRejectsUnboundedOrAmbiguousInput(t *testing.T) {
	for _, values := range []url.Values{
		{"page": {"0"}}, {"page": {"01"}}, {"page": {"1000001"}}, {"page": {"9223372036854775807"}},
		{"pageSize": {"101"}}, {"pageSize": {"1.2"}}, {"sort": {"event_timestamp; DROP TABLE x"}},
		{"listingStatus": {"ACTIVE"}}, {"q": {strings.Repeat("文", 101)}}, {"q": {"a\x00b"}},
		{"q": {"one", "two"}}, {"source": {"opensea", "other"}}, {"contract": {"one", "two"}},
	} {
		if _, err := parseMarketCatalogQuery(values); err == nil {
			t.Fatalf("accepted invalid query: %#v", values)
		}
	}
	if _, err := parseMarketCatalogQuery(url.Values{"q": {strings.Repeat("文", 100)}, "page": {"1000000"}, "pageSize": {"100"}}); err != nil {
		t.Fatal(err)
	}
}

func TestMarketCatalogQueryStatusAndLosslessSort(t *testing.T) {
	for _, status := range []string{"all", "active", "inactive"} {
		for _, order := range []string{"newest", "oldest", "token"} {
			query, err := parseMarketCatalogQuery(url.Values{"listingStatus": {status}, "sort": {order}})
			if err != nil {
				t.Fatal(err)
			}
			where, args := query.filterSQL()
			if len(args) != 0 || (status == "inactive" && !strings.Contains(where, "AND NOT")) || (status == "active" && !strings.Contains(where, "AND (order_status")) {
				t.Fatalf("bad status filter %s", where)
			}
			clause := query.orderSQL()
			if strings.Contains(clause, "CAST") || !strings.Contains(clause, "CHAR_LENGTH(token_id), token_id") || !strings.Contains(clause, "chain_name, contract_address") {
				t.Fatalf("not lossless deterministic ordering: %s", clause)
			}
			if order == "oldest" && !strings.Contains(clause, "event_timestamp ASC") {
				t.Fatal(clause)
			}
			if order == "newest" && !strings.Contains(clause, "event_timestamp DESC") {
				t.Fatal(clause)
			}
		}
	}
}
