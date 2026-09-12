-- Unnumbered TEST_ONLY schema draft. Apply only to an approved exclusive CTYun
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

-- Reservations never disappear on an UNKNOWN outcome or expired process lease.
-- Each first-slice authorization permits one execution; a second operation ID
-- cannot reserve the same nonce or signed intent ID.
CREATE TABLE agent_slice_reservations (
  authority_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  intent_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  operation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  intent_digest CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  CONSTRAINT fk_agent_slice_reservation_operation FOREIGN KEY (operation_id)
    REFERENCES agent_slice_operations(operation_id)
) ENGINE=InnoDB;
