ALTER TABLE chain_events
    DROP CONSTRAINT chk_chain_event_chain,
    ADD CONSTRAINT chk_chain_event_chain CHECK (chain_id = 11155111);

ALTER TABLE rwa_mint_intents
    DROP CONSTRAINT chk_rwa_mint_chain,
    ADD CONSTRAINT chk_rwa_mint_chain CHECK (chain_id = 11155111);
