package httpapi

import (
	"bytes"
	"crypto/hmac"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var nftOperationID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,80}$`)
var nftDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type nftOperation struct {
	ID              string          `json:"id"`
	Wallet          string          `json:"wallet"`
	ChainID         int             `json:"chainId"`
	RequestHash     string          `json:"requestHash"`
	Revision        int             `json:"revision"`
	Status          string          `json:"status"`
	WalletStarted   bool            `json:"walletStarted"`
	Plan            json.RawMessage `json:"plan"`
	TransactionHash string          `json:"transactionHash,omitempty"`
	OrderHash       string          `json:"orderHash,omitempty"`
	UpdatedAt       string          `json:"updatedAt"`
}
type nftOperationInput struct {
	Action      string       `json:"action"`
	AccessToken string       `json:"accessToken"`
	Operation   nftOperation `json:"operation"`
}

func registerNFTOperations(mux *http.ServeMux, auth *userAuthService) {
	mux.HandleFunc("POST /v1/nft/operations", auth.nftOperations)
	mux.HandleFunc("POST /v1/nft/operations/history", auth.nftOperationHistory)
}

func (service *userAuthService) nftOperations(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !service.available() {
		service.writeError(writer, request, errUserAuthUnavailable)
		return
	}
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || !hmac.Equal([]byte(strings.TrimPrefix(authorization, "Bearer ")), service.bridgeToken) {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 65537))
	if err != nil || len(body) > 65536 {
		writeProblem(writer, request, 413, "Invalid NFT record", "The record is too large.")
		return
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	var input nftOperationInput
	if readUserAuthJSON(request, &input) != nil || !nftOperationID.MatchString(input.Operation.ID) {
		writeProblem(writer, request, 400, "Invalid NFT record", "A valid operation is required.")
		return
	}
	session, err := service.authenticate(request.Context(), input.AccessToken, false)
	if err != nil {
		service.writeError(writer, request, err)
		return
	}
	principal := verifiedNFTPrincipal{wallet: session.Address, chainID: session.ChainID, sessionID: session.ID}
	operation, err := (&nftOperationStore{db: service.db, now: service.now}).apply(request.Context(), principal, input.Action, input.Operation)
	if err != nil {
		writeNFTStoreError(writer, request, err)
		return
	}
	writeJSON(writer, http.StatusOK, operation)
}
