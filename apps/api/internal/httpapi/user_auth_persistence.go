package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

func (service *userAuthService) persistUserChallenge(ctx context.Context, challenge *userAuthChallenge) error {
	if service.db == nil {
		return errUserAuthUnavailable
	}
	_, err := service.db.ExecContext(ctx, `
  INSERT INTO wallet_user_challenges
   (challenge_id, wallet_address, chain_id, origin, nonce, issued_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`, challenge.ID, challenge.Address, challenge.ChainID, challenge.Origin, challenge.nonce, time.UnixMilli(challenge.IssuedAt).UTC(), time.UnixMilli(challenge.ExpiresAt).UTC())
	return err
}

// The challenge lock, single-use transition, session insert and first refresh
// insert share one transaction. Any failure rolls all four back together.
func (service *userAuthService) consumeChallenge(ctx context.Context, input userVerifyInput) (*userAuthTokens, error) {
	if service.db == nil {
		return nil, errUserAuthUnavailable
	}
	sessionID, err := userRandomToken(16)
	if err != nil {
		return nil, err
	}
	refreshToken, err := userRandomToken(32)
	if err != nil {
		return nil, err
	}
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var challenge userAuthChallenge
	var issuedAt, expiresAt time.Time
	var consumedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `
  SELECT challenge_id, wallet_address, chain_id, origin, nonce, issued_at, expires_at, consumed_at
  FROM wallet_user_challenges WHERE challenge_id = ? FOR UPDATE`, input.ChallengeID).Scan(
		&challenge.ID, &challenge.Address, &challenge.ChainID, &challenge.Origin, &challenge.nonce, &issuedAt, &expiresAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errUserUnauthorized
	}
	if err != nil {
		return nil, err
	}
	challenge.IssuedAt, challenge.ExpiresAt = issuedAt.UnixMilli(), expiresAt.UnixMilli()
	now := service.now().UTC().Truncate(time.Second)
	if consumedAt.Valid || !now.Before(expiresAt) || now.Before(issuedAt) || expiresAt.Sub(issuedAt) != userChallengeLifetime ||
		challenge.Address != strings.ToLower(input.Address) || challenge.ChainID != input.ChainID || challenge.Origin != input.Origin || challenge.Origin != service.origin || input.Message != userChallengeMessage(&challenge) {
		return nil, errUserUnauthorized
	}
	session := userAuthSession{ID: sessionID, Address: challenge.Address, ChainID: challenge.ChainID, origin: challenge.Origin, createdAt: now, ExpiresAt: now.Add(userSessionLifetime).UnixMilli()}
	accessToken, accessExpiresAt, err := service.issueAccess(session)
	if err != nil {
		return nil, err
	}
	session.AccessExpiresAt = accessExpiresAt
	result, err := tx.ExecContext(ctx, `UPDATE wallet_user_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL`, now, challenge.ID)
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected != 1 {
		return nil, errUserUnauthorized
	}
	if _, err = tx.ExecContext(ctx, `
  INSERT INTO wallet_user_sessions (session_id, wallet_address, chain_id, origin, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?)`, session.ID, session.Address, session.ChainID, session.origin, session.createdAt, time.UnixMilli(session.ExpiresAt).UTC()); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO wallet_user_refresh_tokens (token_hash, session_id, created_at) VALUES (?, ?, ?)`, userTokenHash(refreshToken), session.ID, now); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &userAuthTokens{Session: session, AccessToken: accessToken, RefreshToken: refreshToken}, nil
}

type userSessionScanner interface{ Scan(...any) error }

const selectUserSession = `SELECT session_id, wallet_address, chain_id, origin, created_at, expires_at, revoked_at FROM wallet_user_sessions WHERE session_id = ?`

func scanUserSession(row userSessionScanner) (*userAuthSession, error) {
	var session userAuthSession
	var expiresAt time.Time
	var revokedAt sql.NullTime
	err := row.Scan(&session.ID, &session.Address, &session.ChainID, &session.origin, &session.createdAt, &expiresAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errUserUnauthorized
	}
	if err != nil {
		return nil, err
	}
	session.ExpiresAt, session.revoked = expiresAt.UnixMilli(), revokedAt.Valid
	return &session, nil
}

func (service *userAuthService) loadUserSession(ctx context.Context, id string) (*userAuthSession, error) {
	if service.db == nil {
		return nil, errUserAuthUnavailable
	}
	rows, err := service.db.QueryContext(ctx, selectUserSession, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, errUserUnauthorized
	}
	return scanUserSession(rows)
}

func (service *userAuthService) refreshSessionID(ctx context.Context, token string) (string, error) {
	if service.db == nil {
		return "", errUserAuthUnavailable
	}
	rows, err := service.db.QueryContext(ctx, `SELECT session_id FROM wallet_user_refresh_tokens WHERE token_hash = ?`, userTokenHash(token))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", errUserUnauthorized
	}
	var id string
	if err := rows.Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

// A refresh token's historical hash remains until its session is removed. Reuse
// revokes the entire session, including a token just won by a concurrent refresh.
// All refresh/logout writers lock the session first to maintain one lock order.
func (service *userAuthService) rotateRefresh(ctx context.Context, token string) (*userAuthTokens, error) {
	if !validUserRefreshToken(token) {
		return nil, errUserUnauthorized
	}
	sessionID, err := service.refreshSessionID(ctx, token)
	if err != nil {
		return nil, err
	}
	replacement, err := userRandomToken(32)
	if err != nil {
		return nil, err
	}
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	session, err := scanUserSession(tx.QueryRowContext(ctx, selectUserSession+" FOR UPDATE", sessionID))
	if err != nil {
		return nil, err
	}
	now := service.now().UTC().Truncate(time.Second)
	if session.revoked || session.ExpiresAt <= now.UnixMilli() || session.origin != service.origin || !userAuthChainEnabled(session.ChainID) {
		return nil, errUserUnauthorized
	}
	var consumedAt sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT consumed_at FROM wallet_user_refresh_tokens WHERE token_hash = ? AND session_id = ? FOR UPDATE`, userTokenHash(token), sessionID).Scan(&consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errUserUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if consumedAt.Valid {
		if _, err := tx.ExecContext(ctx, `UPDATE wallet_user_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`, now, sessionID); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, errUserUnauthorized
	}
	accessToken, accessExpiresAt, err := service.issueAccess(*session)
	if err != nil {
		return nil, err
	}
	session.AccessExpiresAt = accessExpiresAt
	if _, err := tx.ExecContext(ctx, `UPDATE wallet_user_refresh_tokens SET consumed_at = ? WHERE token_hash = ?`, now, userTokenHash(token)); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO wallet_user_refresh_tokens (token_hash, session_id, created_at) VALUES (?, ?, ?)`, userTokenHash(replacement), sessionID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &userAuthTokens{Session: *session, AccessToken: accessToken, RefreshToken: replacement}, nil
}

func (service *userAuthService) revokeUserSession(ctx context.Context, accessSessionID, refreshToken string) error {
	if service.db == nil {
		return errUserAuthUnavailable
	}
	sessionID := accessSessionID
	if validUserRefreshToken(refreshToken) {
		refreshID, err := service.refreshSessionID(ctx, refreshToken)
		if err != nil && (!errors.Is(err, errUserUnauthorized) || sessionID == "") {
			return err
		}
		if err == nil {
			if sessionID != "" && sessionID != refreshID {
				return errUserUnauthorized
			}
			sessionID = refreshID
		}
	}
	if sessionID == "" {
		return errUserUnauthorized
	}
	tx, err := service.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	session, err := scanUserSession(tx.QueryRowContext(ctx, selectUserSession+" FOR UPDATE", sessionID))
	if err != nil {
		return err
	}
	if session.origin != service.origin || !userAuthChainEnabled(session.ChainID) {
		return errUserUnauthorized
	}
	if _, err := tx.ExecContext(ctx, `UPDATE wallet_user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE session_id = ?`, service.now().UTC(), sessionID); err != nil {
		return err
	}
	return tx.Commit()
}
