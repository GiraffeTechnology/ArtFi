-- Public-market synchronization metadata. This is not an asset ledger.
CREATE TABLE external_market_observations (
    source VARCHAR(32) NOT NULL,
    collection_slug VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    last_status ENUM('complete', 'unavailable') NOT NULL,
    observed_at_ms BIGINT UNSIGNED NOT NULL,
    received_at_ms BIGINT UNSIGNED NOT NULL,
    last_success_at_ms BIGINT UNSIGNED NULL,
    covered_through_seconds BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (source, collection_slug),
    CONSTRAINT chk_market_observation_time CHECK (
        observed_at_ms > 0 AND received_at_ms > 0
        AND (covered_through_seconds IS NULL OR covered_through_seconds > 0)
    ),
    CONSTRAINT chk_market_observation_success CHECK (
        (last_success_at_ms IS NULL AND covered_through_seconds IS NULL)
        OR (last_success_at_ms IS NOT NULL AND covered_through_seconds IS NOT NULL)
    )
);
