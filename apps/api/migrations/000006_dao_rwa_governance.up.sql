CREATE TABLE governance_daos (
    governor_address CHAR(42) PRIMARY KEY,
    chain_id BIGINT UNSIGNED NOT NULL,
    vault_address CHAR(42) NOT NULL,
    governance_token_address CHAR(42) NOT NULL,
    action_registry_address CHAR(42) NOT NULL,
    buyout_verifier_address CHAR(42) NOT NULL,
    rwa_collection_address CHAR(42) NOT NULL,
    rwa_token_id VARCHAR(78) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_governance_dao_vault (chain_id, vault_address),
    KEY idx_governance_dao_rwa (chain_id, rwa_collection_address, rwa_token_id, active)
);

ALTER TABLE governance_proposals
    ADD COLUMN proposal_kind ENUM('market_migration', 'physical_action', 'forced_buyout') NULL AFTER proposer_address,
    ADD COLUMN action_target CHAR(42) NULL AFTER proposal_kind,
    ADD COLUMN action_calldata_hash BINARY(32) NULL AFTER action_target,
    ADD COLUMN approval_numerator INT UNSIGNED NULL AFTER action_calldata_hash,
    ADD COLUMN approval_denominator INT UNSIGNED NULL AFTER approval_numerator,
    ADD COLUMN evidence_hash BINARY(32) NULL AFTER approval_denominator,
    ADD COLUMN evidence_uri VARCHAR(1024) NULL AFTER evidence_hash,
    ADD COLUMN rwa_verified BOOLEAN NOT NULL DEFAULT FALSE AFTER evidence_uri,
    ADD CONSTRAINT chk_governance_approval CHECK (
        (approval_numerator IS NULL AND approval_denominator IS NULL)
        OR (approval_denominator = 1000000 AND approval_numerator IN (500000, 666667, 800000))
    );

ALTER TABLE governance_votes
    ADD COLUMN snapshot_block BIGINT UNSIGNED NOT NULL AFTER voter_address,
    ADD COLUMN rights_verified BOOLEAN NOT NULL DEFAULT FALSE AFTER weight;

CREATE TABLE governance_buyout_terms (
    proposal_id VARCHAR(78) PRIMARY KEY,
    unit_price_wei VARCHAR(78) NOT NULL,
    pricing_rule ENUM('t0_tminus30_vwap', 'latest_10_actual_vwap') NOT NULL,
    observation_start BIGINT UNSIGNED NULL,
    observation_end BIGINT UNSIGNED NOT NULL,
    trade_count INT UNSIGNED NOT NULL,
    verifier_address CHAR(42) NOT NULL,
    evidence_hash BINARY(32) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_governance_buyout_proposal FOREIGN KEY (proposal_id) REFERENCES governance_proposals(proposal_id)
);

CREATE TABLE governance_failure_assessments (
    assessment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    proposal_id VARCHAR(78) NOT NULL,
    total_cost_wei VARCHAR(78) NOT NULL,
    payment_deadline BIGINT UNSIGNED NOT NULL,
    evidence_hash BINARY(32) NOT NULL,
    evidence_uri VARCHAR(1024) NOT NULL,
    enforcement_status ENUM('recorded', 'notice_pending', 'disputed', 'settled') NOT NULL DEFAULT 'recorded',
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY idx_governance_assessment_proposal (proposal_id, created_at),
    CONSTRAINT fk_governance_assessment_proposal FOREIGN KEY (proposal_id) REFERENCES governance_proposals(proposal_id)
);
