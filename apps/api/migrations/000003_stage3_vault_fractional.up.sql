ALTER TABLE rwa_mint_intents
    ADD COLUMN payload_hash BINARY(32) NULL AFTER idempotency_key_hash;

CREATE TABLE vaults (
    vault_id CHAR(32) PRIMARY KEY,
    request_id BINARY(32) NOT NULL UNIQUE,
    idempotency_key_hash BINARY(32) NOT NULL UNIQUE,
    payload_hash BINARY(32) NOT NULL,
    factory_address CHAR(42) NOT NULL,
    vault_address CHAR(42) NULL UNIQUE,
    collection_address CHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    vault_name VARCHAR(80) NOT NULL,
    admin_address CHAR(42) NOT NULL,
    pauser_address CHAR(42) NOT NULL,
    fractionalizer_address CHAR(42) NOT NULL,
    status ENUM('prepared', 'submitted', 'created', 'deposited', 'fractionalized', 'failed') NOT NULL DEFAULT 'prepared',
    transaction_hash CHAR(66) NULL UNIQUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT chk_vault_token_id CHECK (token_id REGEXP '^[0-9]{1,78}$')
);

CREATE TABLE fractionalizations (
    fractionalization_id CHAR(32) PRIMARY KEY,
    vault_id CHAR(32) NOT NULL UNIQUE,
    token_address CHAR(42) NULL UNIQUE,
    token_name VARCHAR(80) NOT NULL,
    token_symbol VARCHAR(12) NOT NULL,
    supply VARCHAR(78) NOT NULL,
    decimals TINYINT UNSIGNED NOT NULL DEFAULT 18,
    recipient CHAR(42) NOT NULL,
    status ENUM('prepared', 'submitted', 'confirmed', 'failed') NOT NULL DEFAULT 'prepared',
    transaction_hash CHAR(66) NULL UNIQUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_fractionalization_vault FOREIGN KEY (vault_id) REFERENCES vaults(vault_id),
    CONSTRAINT chk_fraction_supply CHECK (supply REGEXP '^[0-9]{1,78}$'),
    CONSTRAINT chk_fraction_decimals CHECK (decimals = 18)
);
