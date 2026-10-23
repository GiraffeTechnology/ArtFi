-- Projection tie-break only. Historical event payloads and source versions stay intact.
ALTER TABLE external_market_orders
    ADD COLUMN projection_event_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
