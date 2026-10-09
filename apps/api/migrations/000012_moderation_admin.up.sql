-- Application content review only. These records confer no chain, custody,
-- listing, settlement, fee, seller-priority or registry authority.
CREATE TABLE moderation_cases (
    case_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    reporter_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    target VARCHAR(256) NOT NULL,
    category ENUM('misleading_metadata','inappropriate_content','suspected_fraud','other') NOT NULL,
    details TEXT NOT NULL,
    status ENUM('open','reviewing','resolved','appealed') NOT NULL DEFAULT 'open',
    decision ENUM('none','no_action','content_warning') NOT NULL DEFAULT 'none',
    decision_reason TEXT NOT NULL,
    public_notice VARCHAR(500) NOT NULL DEFAULT '',
    revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
    appeal_status ENUM('none','pending','upheld','rejected') NOT NULL DEFAULT 'none',
    appeal_statement TEXT NOT NULL,
    appeal_response TEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    updated_at TIMESTAMP(6) NOT NULL,
    KEY idx_moderation_owner (reporter_address, created_at, case_id),
    KEY idx_moderation_queue (status, created_at, case_id)
);
CREATE TABLE platform_configuration (
    configuration_id TINYINT UNSIGNED PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL,
    notice_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    notice_text VARCHAR(500) NOT NULL DEFAULT '',
    updated_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT chk_single_platform_configuration CHECK (configuration_id = 1)
);
INSERT INTO platform_configuration VALUES (1, 1, FALSE, '', CURRENT_TIMESTAMP(6));
-- Receipt and mutation are committed atomically. Keys are actor-scoped and
-- bound to the exact operation and payload, including the expected revision.
CREATE TABLE administration_requests (
    actor_hash BINARY(32) NOT NULL,
    key_hash BINARY(32) NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    response JSON NULL,
    response_status SMALLINT UNSIGNED NULL,
    created_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (actor_hash, key_hash)
);
