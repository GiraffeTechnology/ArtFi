-- Unnumbered TEST_ONLY schema draft. Apply only to an approved exclusive
-- <CLOUD_PROVIDER_A> TEST_ONLY database
-- test schema after integration assigns the actual next-free migration number.
CREATE TABLE agent_slice_operations (
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_json JSON NOT NULL,
  record_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  lease_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_ms BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- Append-only operational history. Application code has no update/delete path.
-- Bodies deliberately exclude signatures, wallet material and driver errors.
CREATE TABLE agent_slice_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_version BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at_ms BIGINT UNSIGNED NOT NULL,
  event_json JSON NOT NULL,
  UNIQUE KEY uq_agent_slice_event (operation_id, operation_version, kind),
  CONSTRAINT fk_agent_slice_event_operation FOREIGN KEY (operation_id)
    REFERENCES agent_slice_operations(operation_id),
  KEY ix_agent_slice_event_page (operation_id, event_id)
) ENGINE=InnoDB;

-- Exposure is a conservative monotonic reservation for the first BUY slice.
-- It is never released merely because a process lease expires or an outcome is
-- UNKNOWN. A later reviewed accounting stage may define narrower release rules.
CREATE TABLE agent_slice_wallet_exposure (
  exposure_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  -- MySQL DECIMAL precision is capped at 65 digits. The application validates
  -- this canonical decimal string as uint256 before every write and after read.
  reserved_value VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB;

-- Reservations never disappear on an UNKNOWN outcome or expired process lease.
-- Each first-slice authorization permits one execution; a second operation ID
-- cannot reserve the same nonce or signed intent ID.
CREATE TABLE agent_slice_reservations (
  authority_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  intent_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  exposure_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  intent_digest CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reserved_value VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT fk_agent_slice_reservation_operation FOREIGN KEY (operation_id)
    REFERENCES agent_slice_operations(operation_id),
  CONSTRAINT fk_agent_slice_reservation_exposure FOREIGN KEY (exposure_key)
    REFERENCES agent_slice_wallet_exposure(exposure_key)
) ENGINE=InnoDB;

-- Multi-action TEST_ONLY authority ledger. One nonce and intent ID bind one
-- unchanged EIP-712 envelope, while separate operations consume its shared limits.
CREATE TABLE agent_action_authorities (
  authority_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  intent_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  wallet_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  intent_digest CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  envelope_json JSON NOT NULL,
  ledger_json JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE agent_action_wallets (
  wallet_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  ledger_json JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE agent_action_workflows (
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  authority_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_json JSON NOT NULL,
  record_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  lease_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_agent_action_authority FOREIGN KEY (authority_key) REFERENCES agent_action_authorities(authority_key)
) ENGINE=InnoDB;
CREATE TABLE agent_action_open_orders (
  resource_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  alias_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  authority_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wallet_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_agent_action_open_operation FOREIGN KEY (operation_id) REFERENCES agent_action_workflows(operation_id)
) ENGINE=InnoDB;
CREATE TABLE agent_action_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_version BIGINT UNSIGNED NOT NULL,
  observed_at_ms BIGINT UNSIGNED NOT NULL,
  event_json JSON NOT NULL,
  UNIQUE KEY uq_agent_action_event (operation_id, operation_version),
  CONSTRAINT fk_agent_action_event_operation FOREIGN KEY (operation_id) REFERENCES agent_action_workflows(operation_id),
  KEY ix_agent_action_event_page (operation_id, event_id)
) ENGINE=InnoDB;
