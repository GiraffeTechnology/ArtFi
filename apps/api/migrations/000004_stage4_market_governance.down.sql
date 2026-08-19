DROP TABLE IF EXISTS governance_votes;
DROP TABLE IF EXISTS governance_proposals;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS account_transactions;
DROP TABLE IF EXISTS portfolio_deltas;
DROP TABLE IF EXISTS external_market_orders;
DROP TABLE IF EXISTS external_market_events;

ALTER TABLE chain_events
    DROP INDEX idx_chain_event_block,
    DROP COLUMN confirmations,
    DROP COLUMN removed,
    DROP COLUMN payload_hash,
    ADD INDEX idx_chain_event_block (chain_id, block_number);
