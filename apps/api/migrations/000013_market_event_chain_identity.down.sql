-- Intentionally fails atomically if removing chain scope would collide.
-- Never delete valid cross-chain history to make an old schema fit.
ALTER TABLE external_market_events
    DROP INDEX uq_external_market_version,
    ADD UNIQUE KEY uq_external_market_version
        (source, event_family, entity_key, event_version, event_type);
