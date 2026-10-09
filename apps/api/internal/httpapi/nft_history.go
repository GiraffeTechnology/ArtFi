package httpapi

import (
	"crypto/hmac"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type nftHistoryInput struct {
	AccessToken string `json:"accessToken"`
	Page        int    `json:"page"`
}
type nftHistoryItem struct {
	ID              string `json:"id"`
	ChainID         int    `json:"chainId"`
	Status          string `json:"status"`
	Action          string `json:"action"`
	Collection      string `json:"collection"`
	TokenID         string `json:"tokenId"`
	Kind            string `json:"kind"`
	WalletStarted   bool   `json:"walletStarted"`
	TransactionHash string `json:"transactionHash,omitempty"`
	OrderHash       string `json:"orderHash,omitempty"`
	UpdatedAt       string `json:"updatedAt"`
}

func (service *userAuthService) nftOperationHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !service.available() {
		service.writeError(w, r, errUserAuthUnavailable)
		return
	}
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || !hmac.Equal([]byte(strings.TrimPrefix(authorization, "Bearer ")), service.bridgeToken) {
		service.writeError(w, r, errUserUnauthorized)
		return
	}
	var input nftHistoryInput
	if readUserAuthJSON(r, &input) != nil || input.Page < 1 || input.Page > 1000000 {
		writeProblem(w, r, 400, "Invalid NFT history request", "Choose a valid operation-history page.")
		return
	}
	session, err := service.authenticate(r.Context(), input.AccessToken, false)
	if err != nil {
		service.writeError(w, r, err)
		return
	}
	rows, err := service.db.QueryContext(r.Context(), `SELECT operation_id,chain_id,status,wallet_started,plan,COALESCE(transaction_hash,''),COALESCE(order_hash,''),updated_at FROM nft_operations WHERE wallet_address=? AND chain_id=? ORDER BY updated_at DESC,operation_id DESC LIMIT 26 OFFSET ?`, session.Address, session.ChainID, (input.Page-1)*25)
	if err != nil {
		service.writeError(w, r, errUserAuthUnavailable)
		return
	}
	defer rows.Close()
	items := make([]nftHistoryItem, 0, 26)
	for rows.Next() {
		var item nftHistoryItem
		var raw []byte
		var updated time.Time
		if rows.Scan(&item.ID, &item.ChainID, &item.Status, &item.WalletStarted, &raw, &item.TransactionHash, &item.OrderHash, &updated) != nil {
			service.writeError(w, r, errUserAuthUnavailable)
			return
		}
		var plan struct {
			Kind    string `json:"kind"`
			Request struct {
				Action     string `json:"action"`
				Collection string `json:"collection"`
				TokenID    string `json:"tokenId"`
			} `json:"request"`
		}
		if json.Unmarshal(raw, &plan) != nil {
			service.writeError(w, r, errUserAuthUnavailable)
			return
		}
		item.Kind = plan.Kind
		item.Action = plan.Request.Action
		item.Collection = plan.Request.Collection
		item.TokenID = plan.Request.TokenID
		item.UpdatedAt = updated.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	if rows.Err() != nil {
		service.writeError(w, r, errUserAuthUnavailable)
		return
	}
	more := len(items) > 25
	if more {
		items = items[:25]
	}
	writeJSON(w, 200, map[string]any{"data": items, "page": input.Page, "pageSize": 25, "hasMore": more, "wallet": session.Address, "chainId": session.ChainID})
}
