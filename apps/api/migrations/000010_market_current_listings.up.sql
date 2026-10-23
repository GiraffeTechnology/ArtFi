-- Read-only provider observations; never an order book or asset ledger.
CREATE TABLE external_market_current_listings (
    source VARCHAR(32) NOT NULL,
    chain_name VARCHAR(32) NOT NULL,
    contract_address CHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    observed_at_ms BIGINT UNSIGNED NOT NULL,
    observation JSON NOT NULL,
    PRIMARY KEY (source, chain_name, contract_address, token_id),
    CONSTRAINT chk_market_listing_observed CHECK (observed_at_ms > 0)
);
