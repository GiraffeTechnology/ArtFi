ALTER TABLE chain_events
    ADD COLUMN payload_hash BINARY(32) NULL AFTER payload,
    ADD COLUMN removed BOOLEAN NOT NULL DEFAULT FALSE AFTER confirmed,
    ADD COLUMN confirmations INT UNSIGNED NOT NULL DEFAULT 0 AFTER removed;

UPDATE chain_events
SET payload_hash = UNHEX(SHA2(CAST(payload AS CHAR), 256));

ALTER TABLE chain_events
    MODIFY COLUMN payload_hash BINARY(32) NOT NULL,
    DROP INDEX idx_chain_event_block,
    ADD INDEX idx_chain_event_block (chain_id, block_number, removed);

CREATE TABLE market_listings (
    listing_id VARCHAR(78) PRIMARY KEY,
    seller_address CHAR(42) NOT NULL,
    asset_token CHAR(42) NOT NULL,
    payment_token CHAR(42) NOT NULL,
    amount_remaining VARCHAR(78) NOT NULL,
    unit_price VARCHAR(78) NOT NULL,
    listing_kind ENUM('fixed', 'auction') NOT NULL,
    status ENUM('active', 'settled', 'cancelled') NOT NULL,
    starts_at BIGINT UNSIGNED NOT NULL,
    ends_at BIGINT UNSIGNED NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);

CREATE TABLE market_offers (
    offer_id CHAR(32) PRIMARY KEY,
    listing_id VARCHAR(78) NOT NULL,
    bidder_address CHAR(42) NOT NULL,
    amount VARCHAR(78) NOT NULL,
    status ENUM('active', 'outbid', 'won', 'refunded') NOT NULL,
    transaction_hash CHAR(66) NOT NULL UNIQUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_market_offer_bidder (bidder_address, status)
);

CREATE TABLE portfolio_deltas (
    chain_id BIGINT UNSIGNED NOT NULL,
    transaction_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    owner_address CHAR(42) NOT NULL,
    asset_token CHAR(42) NOT NULL,
    symbol VARCHAR(12) NOT NULL,
    direction ENUM('credit', 'debit') NOT NULL,
    amount VARCHAR(78) NOT NULL,
    removed BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (chain_id, transaction_hash, log_index, owner_address, direction),
    KEY idx_portfolio_delta_owner (owner_address, asset_token, removed)
);

CREATE TABLE account_transactions (
    account_transaction_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_address CHAR(42) NOT NULL,
    transaction_hash CHAR(66) NOT NULL,
    event_name VARCHAR(80) NOT NULL,
    block_number BIGINT UNSIGNED NOT NULL,
    status ENUM('pending', 'confirmed', 'removed', 'failed') NOT NULL,
    observed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_account_event (owner_address, transaction_hash, event_name),
    KEY idx_account_transactions_owner (owner_address, observed_at)
);

CREATE TABLE notifications (
    notification_id CHAR(32) PRIMARY KEY,
    owner_address CHAR(42) NOT NULL,
    notification_type VARCHAR(80) NOT NULL,
    payload JSON NOT NULL,
    read_at TIMESTAMP(6) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_notifications_owner (owner_address, read_at, created_at)
);

CREATE TABLE governance_proposals (
    proposal_id VARCHAR(78) PRIMARY KEY,
    governor_address CHAR(42) NOT NULL,
    proposer_address CHAR(42) NOT NULL,
    description_hash BINARY(32) NOT NULL,
    status ENUM('pending', 'active', 'defeated', 'succeeded', 'queued', 'executed', 'cancelled') NOT NULL,
    vote_start BIGINT UNSIGNED NOT NULL,
    vote_end BIGINT UNSIGNED NOT NULL,
    eta BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);

CREATE TABLE governance_votes (
    proposal_id VARCHAR(78) NOT NULL,
    voter_address CHAR(42) NOT NULL,
    support TINYINT UNSIGNED NOT NULL,
    weight VARCHAR(78) NOT NULL,
    transaction_hash CHAR(66) NOT NULL UNIQUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (proposal_id, voter_address),
    CONSTRAINT fk_governance_vote_proposal FOREIGN KEY (proposal_id) REFERENCES governance_proposals(proposal_id),
    CONSTRAINT chk_governance_support CHECK (support <= 2)
);
