CREATE TABLE external_market_provider_health (
    source VARCHAR(32) PRIMARY KEY,
    schema_version VARCHAR(8) NOT NULL,
    state ENUM('starting', 'healthy', 'degraded', 'stale', 'stopped') NOT NULL,
    stale BOOLEAN NOT NULL,
    realtime_connected BOOLEAN NOT NULL,
    consecutive_failures BIGINT UNSIGNED NOT NULL,
    observed_at DATETIME(6) NOT NULL,
    last_backfill_success_at DATETIME(6) NULL,
    last_event_at DATETIME(6) NULL,
    last_failure_at DATETIME(6) NULL,
    freshness_lag_seconds BIGINT UNSIGNED NULL,
    stale_after_seconds INT UNSIGNED NOT NULL,
    payload_hash BINARY(32) NOT NULL,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT chk_market_provider_failure_count CHECK (consecutive_failures <= 1000000),
    CONSTRAINT chk_market_provider_stale_window CHECK (stale_after_seconds BETWEEN 1 AND 86400)
);
