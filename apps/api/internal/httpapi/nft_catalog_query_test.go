package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestMintedNFTFiltersRetainCanonicalScope(t *testing.T) {
	where, args, order, err := mintedNFTFilters(url.Values{})
	if err != nil || !strings.Contains(where, "removed = FALSE") || !strings.Contains(where, "chain_id = ?") || !reflect.DeepEqual(args, []any{hoodiChainID}) || !strings.Contains(order, "block_number DESC") {
		t.Fatalf("default canonical scope changed: %q %v %q %v", where, args, order, err)
	}
	canonicalWhere := where
	cases := []struct {
		query string
		want  string
		arg   string
	}{
		{"standard=ERC-721", "event_name = ?", "AssetCreated"},
		{"standard=ERC-1155", "event_name = ?", "SeriesCreated"},
		{"collectionAddress=0x12345678901234567890123456789012aAbB0011", "LOWER(CASE WHEN event_name = 'SeriesCreated' THEN contract_address ELSE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.collectionAddress')) END) = ?", "0x12345678901234567890123456789012aabb0011"},
		{"tokenId=0", "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenId')) = ?", "0"},
		{"tokenId=115792089237316195423570985008687907853269984665640564039457584007913129639935", "JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenId')) = ?", "115792089237316195423570985008687907853269984665640564039457584007913129639935"},
	}
	for _, test := range cases {
		query, _ := url.ParseQuery(test.query)
		where, args, _, err := mintedNFTFilters(query)
		if err != nil || where != canonicalWhere+" AND "+test.want || !reflect.DeepEqual(args, []any{hoodiChainID, test.arg}) {
			t.Errorf("%s: %q %v %v", test.query, where, args, err)
		}
		// The fixed canonical event names are allowed in the base predicate.
		// Every selected value must occupy its own bound placeholder instead.
		if strings.Count(where, "?") != len(args) {
			t.Errorf("query placeholders and bound values differ for %s", test.query)
		}
	}
	_, _, order, err = mintedNFTFilters(url.Values{"sort": {"oldest"}})
	if err != nil || order != "block_number ASC, log_index ASC, transaction_hash ASC" {
		t.Fatalf("unstable chronological ordering: %q %v", order, err)
	}
}

func TestMintedNFTFiltersRejectAmbiguousInputs(t *testing.T) {
	for _, raw := range []string{
		"unknown=x", "holderAddress=0x1000000000000000000000000000000000000001",
		"standard=erc721", "standard=ERC-721&standard=ERC-1155", "sort=price",
		"collectionAddress=0x0000000000000000000000000000000000000000",
		"tokenId=01", "tokenId=-1", "tokenId=1e3", "tokenId=' OR 1=1",
		"tokenId=115792089237316195423570985008687907853269984665640564039457584007913129639936",
		"page=0", "page=01", "page=1000001", "pageSize=101", "pageSize=",
	} {
		query, _ := url.ParseQuery(raw)
		if _, _, _, err := mintedNFTFilters(query); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestMintedNFTBadQueryPrecedesPersistenceAndIsNotCached(t *testing.T) {
	service := &rwaService{}
	for _, raw := range []string{"standard=invalid", "tokenId=%zz", "page=1&page=2"} {
		recorder := httptest.NewRecorder()
		service.getMintedNFTs(recorder, httptest.NewRequest(http.MethodGet, "/v1/nfts?"+raw, nil))
		if recorder.Code != http.StatusBadRequest || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("bad query %q: %d %v", raw, recorder.Code, recorder.Header())
		}
	}
	recorder := httptest.NewRecorder()
	service.getMintedNFTs(recorder, httptest.NewRequest(http.MethodGet, "/v1/nfts?page=1&pageSize=24", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing persistence looked like inventory: %d", recorder.Code)
	}
}
