-- Application inbox projections only. Existing legacy rows and chain authority
-- are preserved; this revision is presentation metadata, not a receipt nonce.
ALTER TABLE notifications
    ADD COLUMN chain_id BIGINT UNSIGNED NULL,
    ADD COLUMN source_kind ENUM('legacy','chain_event','system_notice') NOT NULL DEFAULT 'legacy',
    ADD COLUMN source_key VARCHAR(192) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN source_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
    ADD COLUMN read_revision BIGINT UNSIGNED NULL,
    ADD COLUMN updated_at TIMESTAMP(6) NULL,
    ADD UNIQUE KEY uq_notification_source (owner_address, chain_id, source_kind, source_key);

CREATE TABLE notification_preferences (
    owner_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    chain_id BIGINT UNSIGNED NOT NULL,
    transaction_alerts BOOLEAN NOT NULL DEFAULT TRUE,
    system_message_alerts BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (owner_address, chain_id),
    CONSTRAINT chk_notification_chain CHECK (chain_id > 0)
) ENGINE=InnoDB;

ALTER TABLE chain_events
    ADD COLUMN notification_revision BIGINT UNSIGNED NOT NULL DEFAULT 1;

-- A single statement needs no delimiter extension in the existing migration
-- reader. Old ingestion SQL remains compatible. No notification delivery or
-- preference query is added to canonical event ingestion.
CREATE TRIGGER chain_event_notification_revision
BEFORE UPDATE ON chain_events FOR EACH ROW
SET NEW.notification_revision = OLD.notification_revision + IF(
    OLD.block_number <> NEW.block_number
    OR LOWER(OLD.block_hash) <> LOWER(NEW.block_hash)
    OR OLD.removed <> NEW.removed
    OR OLD.confirmed <> NEW.confirmed, 1, 0);
