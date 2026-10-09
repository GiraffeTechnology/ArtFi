package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const fractionBookLimit = 500

// A book is a read-only log snapshot, not a reservation or authority to settle.
// Seller identity and business role never participate in priority.
func fractionBookScope(values url.Values) ([]any, uint64, error) {
	keys := []string{"chainId", "marketAddress", "assetAddress", "paymentToken", "at"}
	if len(values) != len(keys) {
		return nil, 0, errors.New("exact chain, market, token pair and block time are required")
	}
	for _, key := range keys {
		if len(values[key]) != 1 || values.Get(key) == "" {
			return nil, 0, errors.New("duplicate or missing book scope")
		}
	}
	if values.Get("chainId") != strconv.Itoa(hoodiChainID) {
		return nil, 0, errors.New("unsupported book chain")
	}
	args := []any{hoodiChainID}
	for _, key := range keys[1:4] {
		if !addressPattern.MatchString(values.Get(key)) {
			return nil, 0, errors.New("malformed book address")
		}
		args = append(args, strings.ToLower(values.Get(key)))
	}
	at, err := strconv.ParseUint(values.Get("at"), 10, 48)
	if err != nil || strconv.FormatUint(at, 10) != values.Get("at") {
		return nil, 0, errors.New("block time must be canonical uint48 seconds")
	}
	return args, at, nil
}

func rankFractionBook(orders []signedOrder) error {
	prices := make(map[string]*big.Int, len(orders))
	times := make(map[string]time.Time, len(orders))
	for _, order := range orders {
		price, ok := new(big.Int).SetString(orderString(order.Intent, "unitPrice"), 10)
		created, err := time.Parse(time.RFC3339Nano, order.CreatedAt)
		if !ok || price.Sign() <= 0 || price.BitLen() > 256 || err != nil || order.Kind != "fraction" {
			return errors.New("invalid stored fraction terms")
		}
		if _, exists := prices[order.IntentHash]; exists {
			return errors.New("duplicate fraction authorization")
		}
		prices[order.IntentHash], times[order.IntentHash] = price, created
	}
	sort.Slice(orders, func(i, j int) bool {
		a, b := orders[i].IntentHash, orders[j].IntentHash
		if comparison := prices[a].Cmp(prices[b]); comparison != 0 {
			return comparison < 0
		}
		if !times[a].Equal(times[b]) {
			return times[a].Before(times[b])
		}
		return a < b
	})
	return nil
}

func (service *rwaService) getFractionBook(writer http.ResponseWriter, request *http.Request) {
	args, at, err := fractionBookScope(request.URL.Query())
	if err != nil {
		writeProblem(writer, request, 400, "Invalid fraction book scope", err.Error())
		return
	}
	if service.db == nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The order index is not connected to persistence.")
		return
	}
	// One SELECT observes one committed log snapshot. Its time filter uses the caller's
	// observed chain block, never a server clock or an off-chain lifecycle flag.
	args = append(args, at, at, fractionBookLimit+1)
	rows, err := service.db.QueryContext(request.Context(), `SELECT envelope_json,created_at FROM native_signed_orders WHERE chain_id=? AND market_address=? AND kind='fraction' AND asset_address=? AND JSON_UNQUOTE(JSON_EXTRACT(envelope_json,'$.intent.paymentToken'))=? AND CAST(JSON_UNQUOTE(JSON_EXTRACT(envelope_json,'$.intent.startsAt')) AS UNSIGNED)<=? AND CAST(JSON_UNQUOTE(JSON_EXTRACT(envelope_json,'$.intent.endsAt')) AS UNSIGNED)>? LIMIT ?`, args...)
	if err != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The fraction book could not be read.")
		return
	}
	defer rows.Close()
	orders := make([]signedOrder, 0)
	for rows.Next() {
		order, scanErr := scanSignedOrder(rows)
		if scanErr != nil {
			writeProblem(writer, request, 503, "Order storage unavailable", "The fraction book contains unavailable terms.")
			return
		}
		orders = append(orders, order)
	}
	if rows.Err() != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "The fraction book could not be read.")
		return
	}
	if len(orders) > fractionBookLimit {
		writeProblem(writer, request, 422, "Book snapshot limit reached", "This token pair exceeds the supported 500-candidate snapshot. No truncated match is offered.")
		return
	}
	if rankFractionBook(orders) != nil {
		writeProblem(writer, request, 503, "Order storage unavailable", "Stored fraction priority could not be verified.")
		return
	}
	// Record exact public log inputs for reproducible planning. This hash grants no authority.
	raw, _ := json.Marshal(orders)
	digest := sha256.Sum256(raw)
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, 200, map[string]any{"data": orders, "at": at, "logHash": "0x" + hex.EncodeToString(digest[:]), "priority": "price-time-hash"})
}
