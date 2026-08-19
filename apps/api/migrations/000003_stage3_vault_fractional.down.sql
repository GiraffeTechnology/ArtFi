DROP TABLE IF EXISTS fractionalizations;
DROP TABLE IF EXISTS vaults;

ALTER TABLE rwa_mint_intents
    DROP COLUMN payload_hash;
