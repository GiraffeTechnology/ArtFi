-- Remove only through an authorized migration workflow.
DROP TABLE IF EXISTS agent_action_events;
DROP TABLE IF EXISTS agent_action_open_orders;
DROP TABLE IF EXISTS agent_action_workflows;
DROP TABLE IF EXISTS agent_action_wallets;
DROP TABLE IF EXISTS agent_action_authorities;
-- TEST_ONLY runtime migration rollback. Run only through an authorized migration workflow.
DROP TABLE IF EXISTS agent_slice_reservations;
DROP TABLE IF EXISTS agent_slice_wallet_exposure;
DROP TABLE IF EXISTS agent_slice_events;
DROP TABLE IF EXISTS agent_slice_operations;
