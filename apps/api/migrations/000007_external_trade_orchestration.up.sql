CREATE TABLE external_market_intents (
    intent_id CHAR(32) PRIMARY KEY,
    idempotency_key_hash BINARY(32) NOT NULL UNIQUE,
    payload_hash BINARY(32) NOT NULL,
    source VARCHAR(32) NOT NULL,
    action ENUM('fulfill-listing') NOT NULL,
    chain_name VARCHAR(32) NOT NULL,
    order_hash CHAR(66) NOT NULL,
    contract_address CHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    wallet_address CHAR(42) NOT NULL,
    status ENUM(
        'initiated',
        'awaiting-wallet',
        'submitted',
        'accepted',
        'rejected',
        'pending',
        'confirmed',
        'failed',
        'cancelled'
    ) NOT NULL DEFAULT 'initiated',
    marketplace_url VARCHAR(512) NOT NULL,
    transaction_plan JSON NULL,
    submitted_transaction_hash CHAR(66) NULL,
    external_transaction_hash CHAR(66) NULL,
    failure_code VARCHAR(80) NULL,
    external_event_timestamp TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY idx_external_market_intent_order (source, chain_name, order_hash, status),
    KEY idx_external_market_intent_wallet (wallet_address, created_at),
    CONSTRAINT chk_external_market_intent_token_id
        CHECK (token_id REGEXP '^(0|[1-9][0-9]{0,77})$')
);

CREATE TABLE marketplace_discovery_checks (
    check_id CHAR(32) PRIMARY KEY,
    source ENUM('opensea') NOT NULL,
    chain_name VARCHAR(64) NOT NULL,
    contract_address CHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    result ENUM('discovered', 'not-found', 'unsupported-chain') NOT NULL,
    upstream_status SMALLINT UNSIGNED NOT NULL,
    evidence_sha256 BINARY(32) NOT NULL,
    marketplace_url VARCHAR(1024) NULL,
    observed_at TIMESTAMP(6) NOT NULL,
    KEY idx_marketplace_discovery_asset (
        source,
        chain_name,
        contract_address,
        token_id,
        observed_at
    )
);
