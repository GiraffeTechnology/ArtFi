-- Public catalog publication is not source authority. No source private keys or
-- trust-root creation are supported by application tables.
CREATE TABLE rwa_evidence_locks (
 source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 evidence_id BINARY(32) NOT NULL,
 evidence_hash BINARY(32) NULL,
 created_at TIMESTAMP(6) NOT NULL,
 PRIMARY KEY(source_id,evidence_id)
);
CREATE TABLE rwa_source_revocations (
 source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 evidence_id BINARY(32) NOT NULL,
 revoked_at TIMESTAMP(6) NOT NULL,
 envelope JSON NOT NULL,
 PRIMARY KEY(source_id,evidence_id)
);
CREATE TABLE rwa_catalog_assets (
 slug VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 section ENUM('whole','fractional') NOT NULL,
 source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_asset_key BINARY(32) NOT NULL,
 underlying_model_key BINARY(32) NOT NULL,
 token_model_key BINARY(32) NOT NULL,
 fraction_token_key BINARY(32) NULL,
 chain_id BIGINT UNSIGNED NOT NULL,
 collection_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 token_id VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 fraction_token_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NULL,
 title VARCHAR(120) NOT NULL,
 record JSON NOT NULL,
 evidence JSON NOT NULL,
 evidence_id BINARY(32) NOT NULL,
 context_hash BINARY(32) NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 created_at TIMESTAMP(6) NOT NULL,
 updated_at TIMESTAMP(6) NOT NULL,
 UNIQUE KEY uq_catalog_source_model(source_asset_key),
 UNIQUE KEY uq_catalog_underlying_model(underlying_model_key),
 UNIQUE KEY uq_catalog_token_model(token_model_key),
 UNIQUE KEY uq_catalog_fraction_token(fraction_token_key),
 INDEX idx_catalog_section(section,title,slug),
 INDEX idx_catalog_token(chain_id,collection_address,token_id)
);
CREATE TABLE rwa_mint_evidence (
 intent_id CHAR(32) PRIMARY KEY,
 source_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 evidence_id BINARY(32) NOT NULL,
 asset_key BINARY(32) NOT NULL UNIQUE,
 source_asset_key BINARY(32) NOT NULL UNIQUE,
 evidence JSON NOT NULL,
 verified_at TIMESTAMP(6) NOT NULL,
 UNIQUE KEY uq_mint_source_evidence(source_id,evidence_id),
 CONSTRAINT fk_mint_evidence_intent FOREIGN KEY(intent_id) REFERENCES rwa_mint_intents(intent_id)
);
