-- An order hash/source entity is scoped to its chain, never globally unique.
-- Existing event IDs/payloads are preserved. New IDs include chain identity.
ALTER TABLE external_market_events
    DROP INDEX uq_external_market_version,
    ADD UNIQUE KEY uq_external_market_version
        (source, chain_name, event_family, entity_key, event_version, event_type);
