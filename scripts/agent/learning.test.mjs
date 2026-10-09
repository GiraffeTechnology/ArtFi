import test from "node:test";
import assert from "node:assert/strict";
import { recordOptimization, optimizationHints } from "./learning.mjs";
test("A8 reliability, latency, gas and incident learning emits bounded advice only", () => {
  let state = recordOptimization(null, {
    action: "BID",
    providerId: "RPC_A",
    outcome: "FAILURE",
    reason: "RPC_TIMEOUT",
    durationMs: 1000,
    observedAt: 1,
  });
  state = recordOptimization(state, {
    action: "BID",
    providerId: "RPC_B",
    outcome: "SUCCESS",
    durationMs: 40,
    gasUsed: 45000,
    observedAt: 2,
  });
  assert.equal(state.actions.BID.gasEstimate, 45000);
  assert.equal(state.incidents.RPC_TIMEOUT, 1);
  const hints = optimizationHints(state, {
    approvedProviders: ["RPC_A", "RPC_B"],
    minimumDelayMs: 100,
    maximumDelayMs: 500,
  });
  assert.deepEqual(hints.providerOrder, ["RPC_B", "RPC_A"]);
  assert.equal(hints.recommendedDelayMs, 100);
  assert.equal(hints.policyChangesAllowed, false);
  assert.deepEqual(
    optimizationHints(state, { approvedProviders: ["RPC_A"] }).providerOrder,
    ["RPC_A"],
  );
});
test("A8 refuses authority, trust, jurisdiction and financial updates in learning payloads", () => {
  for (const field of [
    "maxUnitPrice",
    "actionScope",
    "assetScope",
    "jurisdictionPolicy",
    "approvedSources",
    "signerSet",
    "policy",
  ])
    assert.throws(
      () =>
        recordOptimization(null, {
          action: "BUY",
          providerId: "RPC_A",
          outcome: "SUCCESS",
          observedAt: 1,
          [field]: "injected",
        }),
      /OPTIMIZATION_SAMPLE_INVALID/,
    );
});
