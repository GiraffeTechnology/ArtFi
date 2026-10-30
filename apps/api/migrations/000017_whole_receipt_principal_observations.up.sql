-- ArtFi observations of actual Wallet principal/source results only. These
-- tables do not freeze balances, spend money or enable a financial adapter.
CREATE TABLE whole_receipt_principal_observations (
  operation_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL,
  -- LONGTEXT preserves exact server JSON; MySQL JSON normalization would break
  -- strict duplicate/alias/unknown-field rejection on reconstructed records.
  record_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  CONSTRAINT ck_principal_observation_json CHECK (JSON_VALID(record_json))
) ENGINE=InnoDB;

-- Application code has INSERT/read paths only. Each CAS appends exactly one
-- event in the same SQL transaction, including UNKNOWN/reconciliation history.
CREATE TABLE whole_receipt_principal_observation_events (
  operation_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  event_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (operation_id, revision),
  CONSTRAINT ck_principal_observation_event_json CHECK (JSON_VALID(event_json)),
  CONSTRAINT fk_principal_observation_event FOREIGN KEY (operation_id)
    REFERENCES whole_receipt_principal_observations(operation_id)
) ENGINE=InnoDB;
