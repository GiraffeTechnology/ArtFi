-- The write-test chain moved from Ethereum Sepolia (11155111) to Hoodi (560048).
-- Migration 000002 pinned the chain id in two CHECK constraints, so the schema
-- rejected every row the application wrote after the move. Repoint both.
--
-- Hoodi is the test chain only. This says nothing about a production target.

ALTER TABLE rwa_mint_intents
    DROP CONSTRAINT chk_rwa_mint_chain,
    ADD CONSTRAINT chk_rwa_mint_chain CHECK (chain_id = 560048);

ALTER TABLE chain_events
    DROP CONSTRAINT chk_chain_event_chain,
    ADD CONSTRAINT chk_chain_event_chain CHECK (chain_id = 560048);
