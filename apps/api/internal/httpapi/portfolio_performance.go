package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// Direct participants only: a listing ID without an indexed participant does not
// establish wallet relevance. The same fields govern history and invalidation.
var portfolioWalletFields = []string{"from", "to", "owner", "recipient", "distributionWallet", "seller", "buyer", "bidder", "highestBidder", "contributor", "account", "proposer", "voter"}

func portfolioWalletPredicate(prefix, address string) (string, []any) {
	clauses := make([]string, 0, len(portfolioWalletFields))
	args := make([]any, 0, len(portfolioWalletFields))
	for _, field := range portfolioWalletFields {
		clauses = append(clauses, "LOWER(JSON_UNQUOTE(JSON_EXTRACT("+prefix+"payload, '$."+field+"'))) = ?")
		args = append(args, address)
	}
	return strings.Join(clauses, " OR "), args
}

func portfolioEventID(chain int, hash string, index uint32) string {
	return fmt.Sprintf("%d:%s:%d", chain, strings.ToLower(hash), index)
}

type portfolioNotification struct {
	portfolioEntry
	Message string `json:"message"`
}

func portfolioEventNotification(entry portfolioEntry) portfolioNotification {
	message := entry.EventName + " was observed for this wallet. Confirmation is pending."
	if entry.Status == "confirmed" {
		message = entry.EventName + " is confirmed in the indexed chain history."
	}
	if entry.Status == "removed" {
		message = entry.EventName + " was removed from the canonical chain. Any previous confirmation no longer applies."
	}
	return portfolioNotification{portfolioEntry: entry, Message: message}
}

func readPortfolioNotifications(ctx context.Context, tx *sql.Tx, address string) ([]portfolioNotification, error) {
	predicate, args := portfolioWalletPredicate("", address)
	rows, err := tx.QueryContext(ctx, `SELECT LOWER(transaction_hash), log_index,
		LOWER(contract_address), event_name, block_number,
		CASE WHEN removed THEN 'removed' WHEN confirmed THEN 'confirmed' ELSE 'pending' END,
		DATE_FORMAT(observed_at, '%Y-%m-%dT%H:%i:%sZ')
		FROM chain_events WHERE chain_id = ? AND (`+predicate+`)
		ORDER BY observed_at DESC, block_number DESC, log_index DESC, transaction_hash DESC LIMIT 100`, append([]any{hoodiChainID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notifications := []portfolioNotification{}
	for rows.Next() {
		var entry portfolioEntry
		if err := rows.Scan(&entry.TransactionHash, &entry.LogIndex, &entry.ContractAddress, &entry.EventName, &entry.BlockNumber, &entry.Status, &entry.ObservedAt); err != nil {
			return nil, err
		}
		entry.ID = portfolioEventID(hoodiChainID, entry.TransactionHash, entry.LogIndex)
		notifications = append(notifications, portfolioEventNotification(entry))
	}
	return notifications, rows.Err()
}

type portfolioPerformance struct {
	Status             string                     `json:"status"`
	Method             string                     `json:"method"`
	Scope              string                     `json:"scope"`
	Items              []portfolioPerformanceItem `json:"items"`
	UnmappedTradeCount int                        `json:"unmappedTradeCount"`
	PendingEventCount  int                        `json:"pendingEventCount"`
	Reasons            []string                   `json:"reasons"`
}

type portfolioPerformanceItem struct {
	AssetToken        string   `json:"assetToken"`
	PaymentToken      *string  `json:"paymentToken"`
	ConfirmedQuantity *string  `json:"confirmedQuantity"`
	CostBasis         *string  `json:"costBasis"`
	RealizedPnL       *string  `json:"realizedPnl"`
	Status            string   `json:"status"`
	BuyCount          int      `json:"buyCount"`
	SellCount         int      `json:"sellCount"`
	Reasons           []string `json:"reasons"`
}

type portfolioEvidence struct {
	TransactionHash string
	LogIndex        uint32
	BlockNumber     uint64
	BlockHash       string
	ContractAddress string
	EventName       string
	Confirmed       bool
	Removed         bool
	Payload         map[string]json.RawMessage
	Order           *signedOrder
}

const portfolioEvidenceLimit = 20000

func readPortfolioPerformance(ctx context.Context, tx *sql.Tx, address string) (portfolioPerformance, error) {
	predicate, args := portfolioWalletPredicate("e.", address)
	rows, err := tx.QueryContext(ctx, `SELECT LOWER(e.transaction_hash), e.log_index, e.block_number,
 LOWER(e.block_hash), LOWER(e.contract_address), e.event_name, e.confirmed, e.removed,
 e.payload, COALESCE(o.envelope_json, 'null')
 FROM chain_events e LEFT JOIN native_signed_orders o
 ON e.event_name = 'IntentFilled' AND o.chain_id = e.chain_id
 AND o.market_address = LOWER(e.contract_address)
 AND o.intent_hash = LOWER(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.intentHash')))
 WHERE e.chain_id = ? AND e.event_name IN ('Transfer', 'IntentFilled') AND (`+predicate+`)
 ORDER BY e.block_number, e.log_index, e.transaction_hash LIMIT ?`, append(append([]any{hoodiChainID}, args...), portfolioEvidenceLimit+1)...)
	if err != nil {
		return portfolioPerformance{}, err
	}
	defer rows.Close()
	events := make([]portfolioEvidence, 0)
	for rows.Next() {
		var event portfolioEvidence
		var payload, order []byte
		if err := rows.Scan(&event.TransactionHash, &event.LogIndex, &event.BlockNumber, &event.BlockHash, &event.ContractAddress, &event.EventName, &event.Confirmed, &event.Removed, &payload, &order); err != nil {
			return portfolioPerformance{}, err
		}
		if err := json.Unmarshal(payload, &event.Payload); err != nil {
			return portfolioPerformance{}, err
		}
		if err := json.Unmarshal(order, &event.Order); err != nil {
			return portfolioPerformance{}, err
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return portfolioPerformance{}, err
	}
	if len(events) > portfolioEvidenceLimit {
		result := newPortfolioPerformance()
		result.Status = "unknown"
		result.Reasons = append(result.Reasons, "Indexed history exceeds the calculation limit; no partial total is presented.")
		return result, nil
	}
	return calculatePortfolioPerformance(address, events), nil
}

func newPortfolioPerformance() portfolioPerformance {
	return portfolioPerformance{
		Status: "no_indexed_history", Method: "fifo", Scope: "confirmed_indexed_fraction_trades",
		Items: []portfolioPerformanceItem{}, Reasons: []string{
			"Amounts are exact token base units. FIFO covers only matched native fractional fills in the indexed history; it is not a complete account or tax statement.",
			"Gas and other unindexed costs are excluded. No fiat conversion or current market valuation is available. Whole-artwork, NFT and unsupported trades have unknown P&L.",
		},
	}
}

type performanceLot struct{ quantity, unitCost *big.Int }
type performanceAccount struct {
	item               portfolioPerformanceItem
	quantity, realized *big.Int
	lots               []performanceLot
	quantityUnknown    bool
}

func (account *performanceAccount) unknown(reason string) {
	for _, existing := range account.item.Reasons {
		if existing == reason {
			return
		}
	}
	account.item.Reasons = append(account.item.Reasons, reason)
}

type performanceFill struct {
	asset, currency, seller, buyer, key string
	amount, payment, unitCost           *big.Int
}

func evidenceString(event portfolioEvidence, field string) string {
	return strings.ToLower(orderString(event.Payload, field))
}
func positiveEvidenceInteger(value string) (*big.Int, bool) {
	if !canonicalUint256(value) {
		return nil, false
	}
	n, _ := new(big.Int).SetString(value, 10)
	return n, n.Sign() > 0
}
func transferMatchKey(event portfolioEvidence, asset, seller, buyer string) string {
	return strings.Join([]string{event.TransactionHash, event.BlockHash, asset, seller, buyer}, ":")
}
func mappedPerformanceFill(event portfolioEvidence) (performanceFill, bool) {
	order := event.Order
	if order == nil || order.Kind != "fraction" || order.ChainID != hoodiChainID ||
		!strings.EqualFold(order.MarketAddress, event.ContractAddress) || !strings.EqualFold(order.IntentHash, evidenceString(event, "intentHash")) {
		return performanceFill{}, false
	}
	fill := performanceFill{asset: strings.ToLower(orderString(order.Intent, "assetToken")), currency: strings.ToLower(orderString(order.Intent, "paymentToken")), seller: evidenceString(event, "seller"), buyer: evidenceString(event, "buyer")}
	if !addressPattern.MatchString(fill.asset) || !addressPattern.MatchString(fill.currency) || fill.asset == fill.currency || !addressPattern.MatchString(fill.seller) || !addressPattern.MatchString(fill.buyer) || fill.seller == fill.buyer || !strings.EqualFold(fill.seller, orderString(order.Intent, "seller")) {
		return fill, false
	}
	var ok bool
	if fill.amount, ok = positiveEvidenceInteger(evidenceString(event, "amount")); !ok {
		return fill, false
	}
	if fill.payment, ok = positiveEvidenceInteger(evidenceString(event, "payment")); !ok {
		return fill, false
	}
	if fill.unitCost, ok = positiveEvidenceInteger(orderString(order.Intent, "unitPrice")); !ok {
		return fill, false
	}
	if new(big.Int).Mul(fill.amount, fill.unitCost).Cmp(fill.payment) != 0 {
		return fill, false
	}
	fill.key = transferMatchKey(event, fill.asset, fill.seller, fill.buyer)
	return fill, true
}

// Rebuilt from canonical evidence on every cache miss. There is no mutable cost
// ledger to drift across duplicate delivery, confirmation replay or a reorg.
func calculatePortfolioPerformance(address string, input []portfolioEvidence) portfolioPerformance {
	result := newPortfolioPerformance()
	address = strings.ToLower(address)
	events := append([]portfolioEvidence(nil), input...)
	sort.Slice(events, func(i, j int) bool {
		if events[i].BlockNumber != events[j].BlockNumber {
			return events[i].BlockNumber < events[j].BlockNumber
		}
		// Ethereum logIndex is ordered across the entire block, not per transaction.
		if events[i].LogIndex != events[j].LogIndex {
			return events[i].LogIndex < events[j].LogIndex
		}
		return events[i].TransactionHash < events[j].TransactionHash
	})
	accounts := map[string]*performanceAccount{}
	get := func(token string) *performanceAccount {
		if accounts[token] == nil {
			accounts[token] = &performanceAccount{item: portfolioPerformanceItem{AssetToken: token, Status: "unknown", Reasons: []string{}}, quantity: new(big.Int), realized: new(big.Int)}
		}
		return accounts[token]
	}
	filledTotals, transferTotals := map[string]*big.Int{}, map[string]*big.Int{}
	add := func(target map[string]*big.Int, key string, amount *big.Int) {
		if target[key] == nil {
			target[key] = new(big.Int)
		}
		target[key].Add(target[key], amount)
	}
	for _, event := range events {
		if event.Removed || !event.Confirmed {
			continue
		}
		if event.EventName == "IntentFilled" {
			if fill, ok := mappedPerformanceFill(event); ok {
				add(filledTotals, fill.key, fill.amount)
			}
		}
		if event.EventName == "Transfer" {
			if amount, ok := positiveEvidenceInteger(evidenceString(event, "value")); ok {
				add(transferTotals, transferMatchKey(event, event.ContractAddress, evidenceString(event, "from"), evidenceString(event, "to")), amount)
			}
		}
	}
	matched := func(key string) bool {
		return filledTotals[key] != nil && transferTotals[key] != nil && filledTotals[key].Cmp(transferTotals[key]) == 0
	}
	for _, event := range events {
		if event.Removed {
			continue
		}
		if !event.Confirmed {
			result.PendingEventCount++
		}
		switch event.EventName {
		case "Transfer":
			from, to := evidenceString(event, "from"), evidenceString(event, "to")
			if from == to || (from != address && to != address) || evidenceString(event, "value") == "0" {
				continue
			}
			account := get(event.ContractAddress)
			if !event.Confirmed {
				account.unknown("Pending transfer evidence is excluded from confirmed quantities and prevents a complete basis.")
				continue
			}
			amount, ok := positiveEvidenceInteger(evidenceString(event, "value"))
			if !ok {
				account.quantityUnknown = true
				account.unknown("A transfer amount is invalid; quantity and basis are unknown.")
				continue
			}
			if to == address {
				account.quantity.Add(account.quantity, amount)
			} else {
				account.quantity.Sub(account.quantity, amount)
			}
			if !matched(transferMatchKey(event, event.ContractAddress, from, to)) {
				account.unknown("A transfer has no matching confirmed native fractional fill; acquisition cost or disposition proceeds are unknown.")
			}
		case "IntentFilled":
			if evidenceString(event, "seller") != address && evidenceString(event, "buyer") != address {
				continue
			}
			fill, ok := mappedPerformanceFill(event)
			if !ok {
				result.UnmappedTradeCount++
				if fill.asset != "" && addressPattern.MatchString(fill.asset) {
					get(fill.asset).unknown("A fill cannot be verified against its stored fractional sale terms.")
				}
				continue
			}
			account := get(fill.asset)
			if !event.Confirmed {
				account.unknown("Pending fill evidence is excluded from P&L.")
				continue
			}
			if !matched(fill.key) {
				account.unknown("A confirmed fill does not reconcile with the indexed asset transfer in the same transaction and block.")
				continue
			}
			if account.item.PaymentToken == nil {
				currency := fill.currency
				account.item.PaymentToken = &currency
			} else if *account.item.PaymentToken != fill.currency {
				account.unknown("Payment currency changed; currencies are not combined or converted.")
			}
			if fill.buyer == address {
				account.item.BuyCount++
				account.lots = append(account.lots, performanceLot{quantity: new(big.Int).Set(fill.amount), unitCost: new(big.Int).Set(fill.unitCost)})
			} else {
				account.item.SellCount++
				remainder, cost := new(big.Int).Set(fill.amount), new(big.Int)
				for remainder.Sign() > 0 && len(account.lots) > 0 {
					lot := &account.lots[0]
					used := new(big.Int).Set(remainder)
					if used.Cmp(lot.quantity) > 0 {
						used.Set(lot.quantity)
					}
					cost.Add(cost, new(big.Int).Mul(used, lot.unitCost))
					remainder.Sub(remainder, used)
					lot.quantity.Sub(lot.quantity, used)
					if lot.quantity.Sign() == 0 {
						account.lots = account.lots[1:]
					}
				}
				if remainder.Sign() > 0 {
					account.unknown("A sale exceeds the prior matched acquisitions; the opening cost basis is unknown.")
				}
				account.realized.Add(account.realized, new(big.Int).Sub(fill.payment, cost))
			}
		}
	}
	tokens := make([]string, 0, len(accounts))
	for token := range accounts {
		tokens = append(tokens, token)
	}
	sort.Strings(tokens)
	for _, token := range tokens {
		account := accounts[token]
		cost, lotQuantity := new(big.Int), new(big.Int)
		for _, lot := range account.lots {
			cost.Add(cost, new(big.Int).Mul(lot.quantity, lot.unitCost))
			lotQuantity.Add(lotQuantity, lot.quantity)
		}
		if account.item.PaymentToken == nil {
			account.unknown("No matched acquisition/disposition currency is available for this token.")
		}
		if account.quantity.Sign() < 0 || lotQuantity.Cmp(account.quantity) != 0 {
			account.unknown("Indexed transfer balance does not reconcile with the known acquisition lots.")
		}
		if !account.quantityUnknown {
			value := account.quantity.String()
			account.item.ConfirmedQuantity = &value
		}
		if len(account.item.Reasons) == 0 {
			account.item.Status = "known"
			basis, pnl := cost.String(), account.realized.String()
			account.item.CostBasis, account.item.RealizedPnL = &basis, &pnl
		}
		result.Items = append(result.Items, account.item)
	}
	if len(result.Items) > 0 {
		result.Status = "known_for_indexed_history"
	}
	if result.UnmappedTradeCount > 0 || result.PendingEventCount > 0 {
		result.Status = "unknown"
	}
	for _, item := range result.Items {
		if item.Status != "known" {
			result.Status = "unknown"
		}
	}
	return result
}
