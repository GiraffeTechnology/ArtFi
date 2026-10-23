-- Collector transport snapshots, not evidence of joined channels or settlement.
CREATE TABLE external_market_stream_observations (
    source VARCHAR(32) NOT NULL,
    collection_slug VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    transport_state ENUM('connecting', 'connected', 'disconnected', 'stopped') NOT NULL,
    observed_at_ms BIGINT UNSIGNED NOT NULL,
    received_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (source, collection_slug),
    CONSTRAINT chk_market_stream_time CHECK (observed_at_ms > 0 AND received_at_ms > 0)
);
