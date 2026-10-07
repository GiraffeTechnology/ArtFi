-- Wallet login is durable and distinct from operator/indexer credentials.
-- Refresh values are never persisted, only SHA-256 digests of random 256-bit values.
CREATE TABLE wallet_user_challenges (
    challenge_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    wallet_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    chain_id BIGINT UNSIGNED NOT NULL,
    origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nonce CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    UNIQUE KEY uq_wallet_challenge_nonce (nonce),
    KEY idx_wallet_challenge_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE wallet_user_sessions (
    session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    wallet_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    chain_id BIGINT UNSIGNED NOT NULL,
    origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    revoked_at DATETIME(6) NULL,
    KEY idx_wallet_session_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE wallet_user_refresh_tokens (
    token_hash BINARY(32) PRIMARY KEY,
    session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    KEY idx_wallet_refresh_session (session_id),
    CONSTRAINT fk_wallet_refresh_session FOREIGN KEY (session_id)
        REFERENCES wallet_user_sessions (session_id) ON DELETE CASCADE
) ENGINE=InnoDB;
