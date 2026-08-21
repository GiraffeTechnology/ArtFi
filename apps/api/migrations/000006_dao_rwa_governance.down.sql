DROP TABLE IF EXISTS governance_failure_assessments;
DROP TABLE IF EXISTS governance_buyout_terms;

ALTER TABLE governance_votes
    DROP COLUMN rights_verified,
    DROP COLUMN snapshot_block;

ALTER TABLE governance_proposals
    DROP CONSTRAINT chk_governance_approval,
    DROP COLUMN rwa_verified,
    DROP COLUMN evidence_uri,
    DROP COLUMN evidence_hash,
    DROP COLUMN approval_denominator,
    DROP COLUMN approval_numerator,
    DROP COLUMN action_calldata_hash,
    DROP COLUMN action_target,
    DROP COLUMN proposal_kind;

DROP TABLE IF EXISTS governance_daos;
