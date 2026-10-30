package httpapi

import (
	"context"
	"encoding/hex"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// The existing authenticated web bridge registers an original signed charity
// challenge, then consumes it only after signature and held-balance verification.
// This record is not a user login/session, payment grant or property authority.
type charityHolderChallengeInput struct {
	ChallengeHash string `json:"challengeHash"`
	Address       string `json:"address"`
	ChainID       int    `json:"chainId"`
	TokenID       string `json:"tokenId"`
	Origin        string `json:"origin"`
	IssuedAt      int64  `json:"issuedAt"`
	ExpiresAt     int64  `json:"expiresAt"`
}

func (service *userAuthService) validHolderChallenge(input charityHolderChallengeInput) bool {
	hash, err := hex.DecodeString(input.ChallengeHash)
	token, ok := new(big.Int).SetString(input.TokenID, 10)
	now := service.now().UnixMilli()
	return err == nil && len(hash) == 32 && input.ChallengeHash == strings.ToLower(input.ChallengeHash) &&
		addressPattern.MatchString(input.Address) && input.Address == strings.ToLower(input.Address) &&
		input.ChainID == hoodiChainID && userAuthChainEnabled(input.ChainID) && input.Origin == service.origin &&
		ok && token.Sign() > 0 && token.BitLen() <= 256 && token.String() == input.TokenID && len(input.TokenID) <= 78 &&
		input.IssuedAt > 0 && input.IssuedAt <= now+5000 && input.ExpiresAt > now &&
		input.ExpiresAt > input.IssuedAt && input.ExpiresAt-input.IssuedAt == userChallengeLifetime.Milliseconds()
}

func (service *userAuthService) registerHolderChallenge(writer http.ResponseWriter, request *http.Request) {
	var input charityHolderChallengeInput
	if err := readUserAuthJSON(request, &input); err != nil || !service.validHolderChallenge(input) {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	if err := service.persistHolderChallenge(request.Context(), input); err != nil {
		service.writeError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (service *userAuthService) consumeHolderChallenge(writer http.ResponseWriter, request *http.Request) {
	var input charityHolderChallengeInput
	if err := readUserAuthJSON(request, &input); err != nil || !service.validHolderChallenge(input) {
		service.writeError(writer, request, errUserUnauthorized)
		return
	}
	if err := service.consumeHolderChallengeRecord(request.Context(), input); err != nil {
		service.writeError(writer, request, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (service *userAuthService) persistHolderChallenge(ctx context.Context, input charityHolderChallengeInput) error {
	if service.db == nil {
		return errUserAuthUnavailable
	}
	hash, err := hex.DecodeString(input.ChallengeHash)
	if err != nil {
		return errUserUnauthorized
	}
	// Never upsert or refresh an existing challenge, including a consumed record.
	result, err := service.db.ExecContext(ctx, `INSERT INTO charity_holder_challenges
 (challenge_hash, wallet_address, chain_id, token_id, origin, issued_at, expires_at)
 VALUES (?, ?, ?, ?, ?, ?, ?)`, hash, input.Address, input.ChainID, input.TokenID, input.Origin,
		time.UnixMilli(input.IssuedAt).UTC(), time.UnixMilli(input.ExpiresAt).UTC())
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errUserUnauthorized
	}
	return nil
}

func (service *userAuthService) consumeHolderChallengeRecord(ctx context.Context, input charityHolderChallengeInput) error {
	if service.db == nil {
		return errUserAuthUnavailable
	}
	hash, err := hex.DecodeString(input.ChallengeHash)
	if err != nil {
		return errUserUnauthorized
	}
	now := service.now().UTC()
	// One conditional InnoDB update is the shared single-use transition. Competing
	// processes must observe zero affected rows after the first committed consumer.
	result, err := service.db.ExecContext(ctx, `UPDATE charity_holder_challenges SET consumed_at = ?
 WHERE challenge_hash = ? AND wallet_address = ? AND chain_id = ? AND token_id = ? AND origin = ?
 AND issued_at = ? AND expires_at = ? AND consumed_at IS NULL AND issued_at <= ? AND expires_at > ?`,
		now, hash, input.Address, input.ChainID, input.TokenID, input.Origin,
		time.UnixMilli(input.IssuedAt).UTC(), time.UnixMilli(input.ExpiresAt).UTC(), now, now)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return errUserUnauthorized
	}
	return nil
}
