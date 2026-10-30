-- Immutable public sale authorizations. Current chain state remains authoritative.
CREATE TABLE native_signed_orders (
    chain_id BIGINT UNSIGNED NOT NULL,
    market_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    intent_hash CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind ENUM('whole', 'fraction') NOT NULL,
    seller_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    asset_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_id VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    envelope_json JSON NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (chain_id, market_address, intent_hash),
    KEY idx_native_asset (chain_id, market_address, kind, asset_address, token_id, created_at),
    KEY idx_native_seller (seller_address, created_at)
);
