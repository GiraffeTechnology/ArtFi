-- Separate purpose from wallet login: an original charity challenge is consumed once.
-- A missing or unavailable authoritative store never falls back to process memory.
CREATE TABLE charity_holder_challenges (
    challenge_hash BINARY(32) PRIMARY KEY,
    wallet_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    chain_id BIGINT UNSIGNED NOT NULL,
    token_id VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at DATETIME(6) NOT NULL,
    expires_at DATETIME(6) NOT NULL,
    consumed_at DATETIME(6) NULL,
    KEY idx_charity_holder_challenge_expiry (expires_at)
) ENGINE=InnoDB;
