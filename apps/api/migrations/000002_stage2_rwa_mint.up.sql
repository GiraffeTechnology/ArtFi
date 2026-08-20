CREATE TABLE rwa_uploads (
    upload_id CHAR(32) PRIMARY KEY,
    object_key VARCHAR(512) NOT NULL UNIQUE,
    file_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    sha256 BINARY(32) NOT NULL,
    status ENUM('pending', 'uploaded', 'failed') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at TIMESTAMP(6) NULL,
    CONSTRAINT chk_rwa_upload_size CHECK (size_bytes > 0 AND size_bytes <= 10485760)
);

CREATE TABLE rwa_mint_intents (
    intent_id CHAR(32) PRIMARY KEY,
    idempotency_key_hash BINARY(32) NOT NULL UNIQUE,
    request_id BINARY(32) NOT NULL UNIQUE,
    upload_id CHAR(32) NOT NULL,
    recipient CHAR(42) NOT NULL,
    registry_address CHAR(42) NOT NULL,
    chain_id BIGINT UNSIGNED NOT NULL,
    metadata_uri VARCHAR(512) NOT NULL,
    metadata_sha256 BINARY(32) NOT NULL,
    status ENUM('prepared', 'submitted', 'confirmed', 'failed') NOT NULL DEFAULT 'prepared',
    transaction_hash CHAR(66) NULL UNIQUE,
    token_id VARCHAR(78) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_rwa_mint_upload FOREIGN KEY (upload_id) REFERENCES rwa_uploads(upload_id),
    CONSTRAINT chk_rwa_mint_chain CHECK (chain_id = 11155111),
    CONSTRAINT chk_rwa_mint_token_id CHECK (token_id IS NULL OR token_id REGEXP '^[0-9]{1,78}$')
);

CREATE TABLE chain_events (
    event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chain_id BIGINT UNSIGNED NOT NULL,
    contract_address CHAR(42) NOT NULL,
    transaction_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    block_number BIGINT UNSIGNED NOT NULL,
    block_hash CHAR(66) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    payload JSON NOT NULL,
    confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_chain_event (chain_id, transaction_hash, log_index),
    INDEX idx_chain_event_block (chain_id, block_number),
    CONSTRAINT chk_chain_event_chain CHECK (chain_id = 11155111)
);
