import { MODE } from "./config.mjs";
export const REQUIRED_ACTIONS = Object.freeze([
  "BUY",
  "CREATE_ORDER",
  "AMEND_ORDER",
  "CANCEL_ORDER",
  "BID",
  "REBID",
  "ACCEPT_OFFER",
  "PARTIAL_FILL",
  "SETTLE",
  "CLAIM",
  "REFUND",
  "RECONCILE",
  "RETRY",
  "ROUTE",
  "SUSPEND_NEW_ACTIVITY",
  "RESUME_ELIGIBLE_ACTIVITY",
]);
export function unavailableCapabilities(
  reason = "EXECUTION_DEPENDENCY_UNAVAILABLE",
  mode = MODE,
) {
  return {
    schemaVersion: 1,
    mode,
    productionReady: false,
    state: "SAFE_DEGRADED",
    adapterKind: "unavailable",
    walletProtocol: "NOT_CONFIRMED",
    capabilities: {
      prepareIntent: false,
      createIntent: false,
      queryIntent: false,
      recordRevocation: false,
      history: false,
      signIntent: false,
      revokeNonce: false,
    },
    actions: REQUIRED_ACTIONS.map((action) => ({
      action,
      available: false,
      reason,
    })),
    constitutionalMutations: false,
    privateKeyCustody: false,
    limitations: [
      "The current Wallet interface requires owner confirmation for each operation; it has no delegated session key, autonomous broadcasting or HTTP agent write endpoint.",
      "Autonomous execution is unavailable. Continue through the existing owner-confirmed ArtFi market screens where applicable.",
      "Approved proof and execution adapters remain unavailable; no complete NO-HIL operation or Stage 2 acceptance is claimed.",
    ],
  };
}
