CREATE TABLE identity_subjects (
    subject_hash BINARY(32) PRIMARY KEY,
    subject_type ENUM('person', 'business') NOT NULL,
    provider_reference_hash BINARY(32) NOT NULL UNIQUE,
    verification_status ENUM('pending', 'approved', 'rejected', 'expired') NOT NULL,
    jurisdiction CHAR(2) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);

CREATE TABLE compliance_assertions (
    assertion_id CHAR(32) PRIMARY KEY,
    subject_hash BINARY(32) NOT NULL,
    policy_version VARCHAR(80) NOT NULL,
    sanctions_cleared BOOLEAN NOT NULL,
    investor_eligible BOOLEAN NOT NULL,
    decision ENUM('allow', 'deny') NOT NULL,
    reason_code VARCHAR(80) NOT NULL,
    issued_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    evidence_hash BINARY(32) NOT NULL,
    CONSTRAINT fk_assertion_subject FOREIGN KEY (subject_hash) REFERENCES identity_subjects(subject_hash),
    KEY idx_assertion_expiry (subject_hash, expires_at)
);

CREATE TABLE asset_legal_records (
    asset_id CHAR(32) PRIMARY KEY,
    title_evidence_hash BINARY(32) NOT NULL,
    custody_agreement_hash BINARY(32) NOT NULL,
    insurance_evidence_hash BINARY(32) NULL,
    redemption_terms_hash BINARY(32) NOT NULL,
    insolvency_terms_hash BINARY(32) NOT NULL,
    approval_status ENUM('draft', 'legal_review', 'approved', 'suspended') NOT NULL,
    approved_by VARCHAR(120) NULL,
    approved_at TIMESTAMP(6) NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);

CREATE TABLE asset_valuations (
    valuation_id CHAR(32) PRIMARY KEY,
    asset_id CHAR(32) NOT NULL,
    amount_minor_units VARCHAR(78) NOT NULL,
    currency CHAR(3) NOT NULL,
    methodology_hash BINARY(32) NOT NULL,
    appraiser_reference_hash BINARY(32) NOT NULL,
    effective_at TIMESTAMP(6) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_valuation_asset FOREIGN KEY (asset_id) REFERENCES asset_legal_records(asset_id)
);

CREATE TABLE redemption_requests (
    redemption_id CHAR(32) PRIMARY KEY,
    asset_id CHAR(32) NOT NULL,
    subject_hash BINARY(32) NOT NULL,
    status ENUM('requested', 'review', 'approved', 'fulfilled', 'rejected', 'cancelled') NOT NULL,
    evidence_hash BINARY(32) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_redemption_asset FOREIGN KEY (asset_id) REFERENCES asset_legal_records(asset_id),
    CONSTRAINT fk_redemption_subject FOREIGN KEY (subject_hash) REFERENCES identity_subjects(subject_hash)
);

CREATE TABLE disputes (
    dispute_id CHAR(32) PRIMARY KEY,
    asset_id CHAR(32) NOT NULL,
    subject_hash BINARY(32) NOT NULL,
    status ENUM('open', 'investigating', 'resolved', 'closed') NOT NULL,
    case_reference_hash BINARY(32) NOT NULL UNIQUE,
    resolution_hash BINARY(32) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT fk_dispute_asset FOREIGN KEY (asset_id) REFERENCES asset_legal_records(asset_id)
);

CREATE TABLE security_audit_log (
    audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    occurred_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    actor_hash BINARY(32) NOT NULL,
    action VARCHAR(120) NOT NULL,
    resource_type VARCHAR(80) NOT NULL,
    resource_hash BINARY(32) NOT NULL,
    decision ENUM('allow', 'deny', 'error') NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    metadata JSON NOT NULL,
    KEY idx_security_audit_time (occurred_at),
    KEY idx_security_audit_resource (resource_type, resource_hash)
);

CREATE TABLE retention_jobs (
    retention_job_id CHAR(32) PRIMARY KEY,
    data_class VARCHAR(80) NOT NULL,
    cutoff_at TIMESTAMP(6) NOT NULL,
    status ENUM('planned', 'approved', 'executing', 'completed', 'failed') NOT NULL,
    approved_by VARCHAR(120) NULL,
    evidence_hash BINARY(32) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at TIMESTAMP(6) NULL
);
