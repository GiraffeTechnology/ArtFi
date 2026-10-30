CREATE TABLE nft_operations (
  operation_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  wallet_address CHAR(42) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chain_id INT UNSIGNED NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  wallet_started BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan JSON NOT NULL,
  transaction_hash CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NULL,
  order_hash CHAR(66) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  INDEX nft_operations_wallet (wallet_address, chain_id, updated_at)
);
