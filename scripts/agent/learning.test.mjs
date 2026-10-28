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

const sample = (id = "RPC_A") => ({
  action: id,
  providerId: id,
  outcome: "SUCCESS",
  durationMs: 40,
  gasUsed: 45000,
  observedAt: 1,
});
const initialState = () => ({
  schemaVersion: 1,
  authority: "ADVISORY_ONLY",
  providers: {
    RPC_A: { successes: 1, failures: 0, latencyMs: 40, gasEstimate: 45000 },
  },
  actions: {
    RPC_A: { successes: 1, failures: 0, latencyMs: 40, gasEstimate: 45000 },
  },
  incidents: {},
  samples: 1,
  observedAt: 1,
});
for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(
    "A8 persists valid prototype-named provider/action " +
      name +
      " without inherited statistics",
    () => {
      const first = recordOptimization(null, sample(name));
      assert.equal(Object.hasOwn(first.providers, name), true);
      assert.equal(Object.hasOwn(first.actions, name), true);
      assert.equal(first.providers[name].successes, 1);
      const restored = JSON.parse(JSON.stringify(first));
      const second = recordOptimization(restored, {
        ...sample(name),
        observedAt: 2,
      });
      assert.equal(second.providers[name].successes, 2);
      assert.equal(second.actions[name].successes, 2);
      assert.equal(restored.providers[name].successes, 1);
      const hints = optimizationHints(second, {
        approvedProviders: ["RPC_BASE", name],
      });
      assert.deepEqual(hints.providerOrder, [name, "RPC_BASE"]);
      assert.equal(hints.authority, "ADVISORY_ONLY");
      assert.equal(hints.policyChangesAllowed, false);
      assert.equal(Object.prototype.successes, undefined);
    },
  );
}
for (const [name, change] of [
  ["NaN latency", (s) => (s.providers.RPC_A.latencyMs = NaN)],
  ["infinite gas", (s) => (s.actions.RPC_A.gasEstimate = Infinity)],
  ["negative latency", (s) => (s.providers.RPC_A.latencyMs = -1)],
  ["string latency", (s) => (s.providers.RPC_A.latencyMs = "40")],
  ["fractional counter", (s) => (s.providers.RPC_A.successes = 0.5)],
  ["oversized counter", (s) => (s.actions.RPC_A.failures = 1000000001)],
  ["oversized latency", (s) => (s.actions.RPC_A.latencyMs = 86400001)],
  ["array provider table", (s) => (s.providers = [])],
  ["null action row", (s) => (s.actions.RPC_A = null)],
  ["unapproved state authority", (s) => (s.authority = "EXECUTE")],
  [
    "injected top-level policy",
    (s) => (s.policy = { maxUnitPrice: "unbounded" }),
  ],
  ["injected row privilege", (s) => (s.providers.RPC_A.approved = true)],
  ["invalid incident count", (s) => (s.incidents.RPC_TIMEOUT = -1)],
  ["invalid incident label", (s) => (s.incidents["lowercase"] = 1)],
  ["missing observation time", (s) => delete s.observedAt],
]) {
  test(
    "A8 rejects persisted " + name + " before accumulating or recommending",
    () => {
      const prior = initialState();
      change(prior);
      assert.throws(
        () => recordOptimization(prior, sample()),
        /OPTIMIZATION_STATE_INVALID/,
      );
      assert.throws(
        () => optimizationHints(prior, { approvedProviders: ["RPC_A"] }),
        /OPTIMIZATION_STATE_INVALID/,
      );
    },
  );
}
test("A8 defaults never read inherited provider names or mutate stored observations", () => {
  const empty = {
    schemaVersion: 1,
    authority: "ADVISORY_ONLY",
    providers: {},
    actions: {},
    incidents: {},
    samples: 0,
  };
  const before = JSON.stringify(empty);
  assert.deepEqual(
    optimizationHints(empty, { approvedProviders: ["constructor", "toString"] })
      .providerOrder,
    ["constructor", "toString"],
  );
  assert.equal(JSON.stringify(empty), before);
  const frozen = Object.freeze(initialState());
  assert.equal(
    optimizationHints(frozen, {
      approvedProviders: ["RPC_A"],
      minimumDelayMs: 100,
      maximumDelayMs: 500,
    }).recommendedDelayMs,
    100,
  );
});
