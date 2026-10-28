package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPortfolioHistoryFiltersRefuseIdentityOverridesAndAmbiguity(t *testing.T) {
	for _, raw := range []string{
		"chainId=1", "sellerAddress=foreign", "address=foreign", "pageSize=100", "provider=foreign",
		"page=0", "page=01", "page=-1", "page=1000001", "page=9007199254740993", "page=",
		"page=1&page=2", "status=all&status=confirmed", "status=live", "order=sideways",
		"eventName=x", "eventName=Transfer%27+OR+1%3D1", "contractAddress=invalid", "status=",
	} {
		t.Run(raw, func(t *testing.T) {
			query, err := url.ParseQuery(raw)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parsePortfolioHistoryFilter(query); err == nil {
				t.Fatal("ambiguous or unsupported history query accepted")
			}
		})
	}
}

func TestPortfolioHistoryScopeUsesOriginalParticipantsAndBoundParameters(t *testing.T) {
	filter, err := parsePortfolioHistoryFilter(url.Values{"status": {"removed"}, "eventName": {"FractionFilled"}, "contractAddress": {"0x1000000000000000000000000000000000000002"}, "order": {"oldest"}, "page": {"11"}})
	if err != nil || filter.Page != 11 || filter.Order != "oldest" {
		t.Fatalf("valid history query refused: %v", err)
	}
	owner := "0x1000000000000000000000000000000000000001"
	where, args := portfolioHistoryPredicate(owner, filter)
	if strings.Contains(where, owner) || strings.Contains(where, filter.EventName) || strings.Contains(where, filter.ContractAddress) {
		t.Fatal("filter value interpolated into SQL")
	}
	if !strings.Contains(where, "removed = TRUE") || !strings.Contains(where, "BINARY event_name = ?") || args[0] != hoodiChainID {
		t.Fatal("status, event or chain scope lost")
	}
	if len(args) != 1+len(portfolioWalletFields)+2 {
		t.Fatal("original participant scope changed")
	}
	for _, argument := range args[1 : 1+len(portfolioWalletFields)] {
		if argument != owner {
			t.Fatal("query participant did not bind the authenticated owner")
		}
	}
	for _, status := range []string{"all", "pending", "confirmed", "removed"} {
		value, err := parsePortfolioHistoryFilter(url.Values{"status": {status}})
		if err != nil || value.Page != 1 || value.Order != "newest" {
			t.Fatal("history defaults changed")
		}
	}
	if _, err := readPortfolioHistory(context.Background(), nil, owner, filter); err == nil {
		t.Fatal("missing persistence became an empty successful history")
	}
}

// TEST_ONLY observations in the original isolated MySQL fixture. These records
// prove query/session behavior, not actual chain execution or property rights.
func TestMySQLPortfolioHistoryPagesBeyondOneHundredAndReconcilesReorg(t *testing.T) {
	db, auth, _, owner := walletAuthIntegrationFixture(t)
	service := newRWAService(rwaConfig{}, newMemoryObjectStore())
	service.db = db
	handler := protectedPortfolioHistory(service, auth)
	tokens := walletAuthIntegrationLogin(t, auth, owner)
	asset := "0x1000000000000000000000000000000000000002"
	otherAsset := "0x1000000000000000000000000000000000000003"
	hashes := make([]string, 117)
	t.Cleanup(func() {
		for _, hash := range hashes {
			if hash != "" {
				if _, err := db.Exec("DELETE FROM chain_events WHERE chain_id=? AND transaction_hash=?", hoodiChainID, hash); err != nil {
					t.Error(err)
				}
			}
		}
	})
	for i := range hashes {
		digest := sha256.Sum256([]byte(fmt.Sprintf("TEST_ONLY_portfolio_history_%s_%d", owner, i)))
		hashes[i] = fmt.Sprintf("0x%x", digest)
		participant := owner
		if i >= 115 {
			participant = userAuthTestAddress
		}
		payload, err := json.Marshal(map[string]string{"owner": participant})
		if err != nil {
			t.Fatal(err)
		}
		payloadHash := sha256.Sum256(payload)
		contract, event := asset, "Transfer"
		if i%2 == 1 {
			contract, event = otherAsset, "FractionFilled"
		}
		confirmations := 0
		if i%3 != 1 {
			confirmations = 1
		}
		_, err = db.Exec(`INSERT INTO chain_events
			(chain_id, transaction_hash, log_index, block_number, block_hash, contract_address,
			 event_name, payload, payload_hash, confirmed, removed, confirmations)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNHEX(?), ?, ?, ?)`,
			hoodiChainID, hashes[i], i%2, 1000+i/2, "0x"+strings.Repeat("a", 64), contract,
			event, payload, fmt.Sprintf("%x", payloadHash), i%3 != 1, i%3 == 0, confirmations)
		if err != nil {
			t.Fatal(err)
		}
	}
	read := func(address, token, query string) (int, portfolioHistoryPage) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/v1/portfolio/"+address+"/history"+query, nil)
		req.SetPathValue("address", address)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler(response, req)
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private history became cacheable")
		}
		var page portfolioHistoryPage
		if response.Code == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
		}
		return response.Code, page
	}
	if status, _ := read(owner, "", ""); status != 401 {
		t.Fatalf("anonymous history exposed: %d", status)
	}
	if status, _ := read(userAuthTestAddress, tokens.AccessToken, ""); status != 403 {
		t.Fatalf("other wallet history exposed: %d", status)
	}
	status, first := read(owner, tokens.AccessToken, "")
	if status != 200 || first.Total != 115 || len(first.Data) != 10 || first.Data[0].TransactionHash != hashes[114] || first.Scope != "indexed_chain_events" || first.Address != strings.ToLower(owner) {
		t.Fatalf("first page/source identity invalid: status%d total%d rows%d", status, first.Total, len(first.Data))
	}
	_, beyond := read(owner, tokens.AccessToken, "?order=oldest&page=11")
	if beyond.Total != 115 || len(beyond.Data) != 10 || beyond.Data[0].TransactionHash != hashes[100] {
		t.Fatal("server history still truncates at one hundred")
	}
	_, last := read(owner, tokens.AccessToken, "?order=oldest&page=12")
	if len(last.Data) != 5 || last.Data[4].TransactionHash != hashes[114] {
		t.Fatal("last partial history page invalid")
	}
	_, filtered := read(owner, tokens.AccessToken, "?status=removed")
	if filtered.Total != 39 {
		t.Fatalf("removed events hidden or confused with confirmed: %d", filtered.Total)
	}
	for _, row := range filtered.Data {
		if row.Status != "removed" {
			t.Fatal("removed status filter lost")
		}
	}
	for _, status := range []string{"pending", "confirmed"} {
		_, selected := read(owner, tokens.AccessToken, "?status="+status)
		if selected.Total != 38 {
			t.Fatalf("%s count mixed pending, confirmed or removed evidence: %d", status, selected.Total)
		}
		for _, row := range selected.Data {
			if row.Status != status {
				t.Fatal("history status filter was not applied before paging")
			}
		}
	}
	_, filtered = read(owner, tokens.AccessToken, "?eventName=Transfer&contractAddress="+asset)
	if filtered.Total != 58 {
		t.Fatalf("event/contract filtering was applied after pagination: %d", filtered.Total)
	}
	_, exactCase := read(owner, tokens.AccessToken, "?eventName=transfer")
	if exactCase.Total != 0 {
		t.Fatal("case-insensitive database comparison changed the requested event")
	}
	for _, query := range []string{"?chainId=1", "?pageSize=100", "?page=0", "?status=%ZZ", "?status=all&status=pending"} {
		if status, _ := read(owner, tokens.AccessToken, query); status != 400 {
			t.Fatalf("invalid or identity-changing query accepted: %s HTTP%d", query, status)
		}
	}
	if _, err := db.Exec("UPDATE chain_events SET removed=FALSE, confirmed=TRUE WHERE chain_id=? AND transaction_hash=?", hoodiChainID, hashes[0]); err != nil {
		t.Fatal(err)
	}
	_, reconciled := read(owner, tokens.AccessToken, "?status=removed")
	if reconciled.Total != 38 {
		t.Fatal("fresh history page reused a stale removed-event total")
	}
	if _, err := db.Exec("UPDATE wallet_user_sessions SET revoked_at=NOW(6) WHERE session_id=?", tokens.Session.ID); err != nil {
		t.Fatal(err)
	}
	if status, _ := read(owner, tokens.AccessToken, "?page=11"); status != 401 {
		t.Fatalf("revoked session retained history access: %d", status)
	}
}
