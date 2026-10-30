import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentKernel, kernelRequestDigest } from "./agent-kernel.mjs";

function fixture() {
  const request = {
    operationId: "TEST_ONLY-store-budget",
    intent: {
      wallet: "0x" + "b".repeat(40),
      nonce: "1",
      maxAggregateExposure: "10",
    },
    sale: { price: "10" },
    execution: { chainId: "560048", executor: "0x" + "a".repeat(40) },
  };
  let row = {
    id: request.operationId,
    request,
    requestDigest: kernelRequestDigest(request),
    state: "PREPARED",
    version: 1,
    leaseToken: "TEST_ONLY_LEASE",
    leaseExpiresAt: Date.now() + 10000,
  };
  const calls = { sends: 0, releases: 0, transitions: [] };
  const store = {
    leaseDurationMs: 10000,
    operationTimeoutMs: 250,
    totalOperationTimeoutMs: 400,
    claim: async () => structuredClone(row),
    renew: async () => {
      row = { ...row, leaseExpiresAt: row.leaseExpiresAt + 1 };
      return structuredClone(row);
    },
    transition: async (_id, version, patch) => {
      assert.equal(version, row.version);
      calls.transitions.push(patch.state);
      row = { ...row, ...patch, version: row.version + 1 };
      return structuredClone(row);
    },
    release: async () => {
      calls.releases++;
    },
  };
  const config = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    store,
    adapterTimeoutMs: 10,
    mintAuthority: async () => ({ status: "EXCLUSIVE_AT_PINNED_BLOCK" }),
    observe: async () => ({}),
    authorize: async () => ({
      state: "AUTHORIZED_NOT_EXECUTED",
      intentDigest: "TEST_ONLY",
      stateVersion: "TEST_ONLY",
      value: "10",
      observedAggregateExposure: "0",
    }),
    execute: async () => {
      calls.sends++;
      return { testOnly: true };
    },
    verify: async () => ({ state: "CONFIRMED" }),
    reconcile: async () => ({
      state: "SETTLED",
      canonical: true,
      accountingMatches: true,
    }),
  };
  return {
    request,
    store,
    config,
    calls,
    terminal: () => {
      row.state = "SETTLED";
    },
  };
}
test("legacy kernel store claim uses its declared budget after the adapter deadline", async () => {
  const f = fixture();
  f.terminal();
  const claim = f.store.claim;
  f.store.claim = async () => {
    await delay(60);
    return claim();
  };
  assert.equal((await createAgentKernel(f.config)(f.request)).state, "SETTLED");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 1);
});
test("legacy durable transitions and release do not inherit the shorter execution deadline", async () => {
  const f = fixture();
  const transition = f.store.transition;
  f.store.transition = async (...args) => {
    await delay(60);
    return transition(...args);
  };
  f.store.release = async () => {
    await delay(60);
    f.calls.releases++;
  };
  const result = await createAgentKernel(f.config)(f.request);
  assert.equal(result.state, "SETTLED");
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.releases, 1);
  assert.deepEqual(f.calls.transitions, [
    "PREPARED",
    "STARTED",
    "SUBMITTED",
    "CONFIRMED",
    "SETTLED",
  ]);
});
test("legacy store claim watchdog remains bounded and cannot dispatch", async () => {
  const f = fixture();
  f.store.operationTimeoutMs = 10;
  f.store.totalOperationTimeoutMs = 30;
  f.store.claim = () => new Promise(() => {});
  const result = await createAgentKernel(f.config)(f.request);
  assert.equal(result.state, "SAFE_DEGRADED");
  assert.equal(result.reason, "DURABLE_STORE_UNAVAILABLE");
  assert.equal(result.storeOutcome, "UNKNOWN");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 0);
});
test("legacy unknown durable mutation retains its lease and never sends after a late response", async () => {
  const f = fixture();
  f.store.operationTimeoutMs = 10;
  f.store.totalOperationTimeoutMs = 30;
  let finish;
  const transition = f.store.transition;
  f.store.transition = (...args) => {
    if (args[2].state !== "STARTED") return transition(...args);
    return new Promise((resolve) => {
      finish = async () => resolve(await transition(...args));
    });
  };
  const result = await createAgentKernel(f.config)(f.request);
  assert.equal(result.state, "SAFE_DEGRADED");
  assert.equal(result.reason, "ADAPTER_STORE_TRANSITION_TIMEOUT");
  assert.equal(result.storeOutcome, "UNKNOWN");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 0);
  await finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 0);
});
test("legacy execution adapter still times out at its own deadline and recovery never resends", async () => {
  const f = fixture();
  let observedSignal;
  f.config.execute = async (_req, _row, signal) => {
    f.calls.sends++;
    observedSignal = signal;
    await delay(60);
    return { testOnly: true };
  };
  const tick = createAgentKernel(f.config);
  const first = await tick(f.request);
  assert.equal(first.state, "SAFE_DEGRADED");
  assert.equal(first.reason, "ADAPTER_EXECUTE_TIMEOUT");
  assert.equal(observedSignal.aborted, true);
  await delay(70);
  assert.equal((await tick(f.request)).state, "SETTLED");
  assert.equal(f.calls.sends, 1);
});
test("legacy kernel lease validation includes the full declared store cleanup budget", () => {
  const f = fixture();
  f.store.leaseDurationMs = 1700;
  assert.throws(
    () => createAgentKernel(f.config),
    /KERNEL_LEASE_BUDGET_INVALID/,
  );
});
test("legacy kernel refuses malformed store budgets rather than widening them", () => {
  for (const total of [undefined, null, NaN, Infinity, 249, 33001]) {
    const f = fixture();
    f.store.totalOperationTimeoutMs = total;
    assert.throws(
      () => createAgentKernel(f.config),
      /KERNEL_LEASE_BUDGET_INVALID/,
    );
  }
});
