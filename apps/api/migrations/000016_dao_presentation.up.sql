-- Apply only after PR174's 000015_notification_inbox and reconcile the real DB ledger.
-- These zero-row reads fail before this schema change if the prior schema is absent.
SELECT notification_revision FROM chain_events LIMIT 0;
SELECT revision FROM notification_preferences LIMIT 0;

-- Optional immutable creation-request presentation; old requests remain SQL NULL.
ALTER TABLE vaults ADD COLUMN presentation_profile_json JSON NULL;
