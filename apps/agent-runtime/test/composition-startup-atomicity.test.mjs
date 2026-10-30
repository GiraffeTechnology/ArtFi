import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const productURL = new URL("../src/composition.mjs", import.meta.url);
const registryKey = Symbol.for("artfi.test.startup.contracts");
const contracts = new Map();
globalThis[registryKey] = contracts;
let sequence = 0;
const mode = "TEST_ONLY_NO_REAL_VALUE";
async function fixture(
  point,
  failures = 1,
  stopOnFailure = false,
  missingAdapter = false,
) {
  const counts = {},
    baseBatches = [],
    actionBatches = [],
    planningBatches = [],
    snapshots = [];
  let epoch = 0,
    currentEpoch = 0,
    controller;
  const abort = new AbortController();
  const hit = (label) => {
    counts[label] = (counts[label] ?? 0) + 1;
    if (point === label && counts[label] <= failures)
      throw Error("TEST_INITIALIZATION_DEPENDENCY_UNAVAILABLE");
  };
  const noop = async () => ({});
  const policy = { mode, autonomousPlanning: true };
  const modules = {
    "../../../scripts/agent/advisory-planner.mjs": {
      createAdvisoryPlanner() {
        hit("planner");
        const generation = currentEpoch;
        return {
          async runBatch() {
            planningBatches.push(generation);
            return { state: "READY" };
          },
        };
      },
    },
    "../../../scripts/agent/stage1-action-plans.mjs": {
      compileStage1Action: noop,
    },
    ethers: {
      isAddress: (value) =>
        typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value),
    },
    "../../../scripts/agent/action-store.mjs": {
      createActionStore: () => ({}),
    },
    "../../../scripts/agent/action-policy.mjs": {
      createActionPolicy() {
        hit("policy");
        return noop;
      },
    },
    "../../../scripts/agent/action-kernel.mjs": {
      createActionKernel() {
        hit("kernel");
        return noop;
      },
      createActionWorker() {
        hit("worker");
        const generation = currentEpoch;
        return {
          async runBatch() {
            actionBatches.push(generation);
            return { attempted: 0, outcomes: [] };
          },
        };
      },
    },
    "../../../scripts/agent/action-service.mjs": {
      createActionService(options) {
        if (options.policy.autonomousPlanning) {
          hit("service");
          return { actionGeneration: currentEpoch };
        }
        return { getAction: noop, actionHistory: noop };
      },
    },
    "../../../scripts/agent/durable-store.mjs": {
      createDurableStore: () => ({}),
    },
    "../../../scripts/agent/runtime.mjs": {
      createDurableRuntime() {
        hit("runtime");
        const generation = ++epoch;
        currentEpoch = generation;
        return {
          service: { runtimeGeneration: generation },
          async runBatch() {
            baseBatches.push(generation);
            return { attempted: 0, outcomes: [] };
          },
        };
      },
    },
    "../../../scripts/agent/bounded-intent.mjs": {
      createIntentAuthorizer: () => noop,
    },
    "./mysql-pool.mjs": {
      async createDatabasePool() {
        hit("pool");
        return {
          async end() {
            hit("close");
          },
        };
      },
      async assertDatabaseSchema() {
        hit("schema");
      },
    },
    "./adapter.mjs": {
      async createFixedAdapter() {
        hit("adapter");
        if (missingAdapter && counts.adapter === 1) return null;
        return { kind: "TEST_ONLY", policy: {}, actionPolicy: policy };
      },
    },
    "./capabilities.mjs": {
      unavailableCapabilities: (reason) => ({
        mode,
        state: "UNAVAILABLE",
        reason,
        capabilities: {},
        actions: [],
        limitations: [],
      }),
    },
    "./config.mjs": {
      MODE: mode,
      stableCode: (error) => error.message,
      fail: (code) => {
        throw Error(code);
      },
    },
  };
  // Only dependency contracts are synthetic. The complete product controller
  // source is evaluated unchanged; no SQL, HTTP, signer or chain is available.
  const fixtureId = String(++sequence);
  const importURL = new URL(productURL);
  importURL.searchParams.set("startup-case", fixtureId);
  const prefix = "artfi-startup-contract:" + fixtureId + "/";
  contracts.set(fixtureId, modules);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (
        context.parentURL === importURL.href &&
        Object.hasOwn(modules, specifier)
      )
        return {
          url: prefix + encodeURIComponent(specifier),
          shortCircuit: true,
        };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith(prefix)) return next(url, context);
      const specifier = decodeURIComponent(url.slice(prefix.length));
      const values = modules[specifier];
      assert.ok(values, "Unexpected dependency: " + specifier);
      return {
        format: "module",
        shortCircuit: true,
        source:
          'const values=globalThis[Symbol.for("artfi.test.startup.contracts")].get(' +
          JSON.stringify(fixtureId) +
          ")[" +
          JSON.stringify(specifier) +
          "];\n" +
          Object.keys(values)
            .map(
              (name) =>
                "export const " +
                name +
                "=values[" +
                JSON.stringify(name) +
                "];",
            )
            .join("\n"),
      };
    },
  });
  let createRuntimeController;
  try {
    ({ createRuntimeController } = await import(importURL.href));
  } finally {
    hook.deregister();
    contracts.delete(fixtureId);
  }
  controller = createRuntimeController({
    config: { mode, database: {}, adapter: {}, worker: { intervalMs: 1 } },
    onState() {
      const state = controller.getStatus();
      const service = controller.getService();
      snapshots.push({
        state: state.state,
        reason: state.reason,
        capabilities: state.capabilities,
        runtimeGeneration: service?.runtimeGeneration,
        actionGeneration: service?.actionGeneration,
      });
      if (
        stopOnFailure ||
        state.state === "TEST_ONLY_READY" ||
        snapshots.length >= 3
      )
        abort.abort();
    },
  });
  await controller.run({ signal: abort.signal });
  await controller.close();
  return { counts, baseBatches, actionBatches, planningBatches, snapshots };
}
for (const point of ["policy", "kernel", "worker", "planner", "service"]) {
  test(
    "retries complete initialization after transient " + point + " failure",
    { timeout: 2000 },
    async () => {
      const r = await fixture(point);
      assert.equal(r.snapshots[0].state, "SAFE_DEGRADED");
      assert.equal(
        r.snapshots[0].runtimeGeneration,
        undefined,
        "partial executable service leaked",
      );
      assert.equal(
        r.counts[point],
        2,
        "failed initialization was never retried",
      );
      assert.equal(r.counts.runtime, 2);
      assert.equal(r.counts.pool, 1, "existing pool must be retained");
      assert.deepEqual(r.baseBatches, [2], "incomplete runtime dispatched");
      assert.deepEqual(r.actionBatches, [2]);
      assert.deepEqual(r.planningBatches, [2]);
      assert.equal(r.snapshots.at(-1).capabilities.actionWorkflows, true);
      assert.equal(r.snapshots.at(-1).capabilities.autonomousPlanning, true);
      assert.equal(r.snapshots.at(-1).runtimeGeneration, 2);
      assert.equal(r.snapshots.at(-1).actionGeneration, 2);
      assert.equal(r.counts.close, 1);
    },
  );
}
test(
  "persistent initialization failure stays degraded with no partial dispatch",
  { timeout: 2000 },
  async () => {
    const r = await fixture("planner", 99);
    assert.equal(r.snapshots.length, 3);
    assert.ok(r.snapshots.every((x) => x.state === "SAFE_DEGRADED"));
    assert.ok(r.snapshots.every((x) => x.runtimeGeneration === undefined));
    assert.deepEqual(r.baseBatches, []);
    assert.deepEqual(r.actionBatches, []);
    assert.deepEqual(r.planningBatches, []);
    assert.equal(r.counts.planner, 3);
  },
);
test(
  "shutdown after failed startup exposes only the original read-only service",
  { timeout: 2000 },
  async () => {
    const r = await fixture("service", 1, true);
    assert.equal(r.snapshots.length, 1);
    assert.equal(r.snapshots[0].runtimeGeneration, undefined);
    assert.deepEqual(r.baseBatches, []);
    assert.deepEqual(r.actionBatches, []);
    assert.equal(r.counts.close, 1);
  },
);
test(
  "successful initialization publishes one coherent generation",
  { timeout: 2000 },
  async () => {
    const r = await fixture();
    assert.deepEqual(r.baseBatches, [1]);
    assert.deepEqual(r.actionBatches, [1]);
    assert.deepEqual(r.planningBatches, [1]);
    assert.equal(r.counts.runtime, 1);
    assert.equal(r.snapshots[0].runtimeGeneration, 1);
    assert.equal(r.snapshots[0].actionGeneration, 1);
  },
);
test(
  "missing adapter can recover without exposing executable state early",
  { timeout: 2000 },
  async () => {
    const r = await fixture(undefined, 1, false, true);
    assert.equal(r.snapshots[0].state, "UNAVAILABLE");
    assert.equal(r.snapshots[0].runtimeGeneration, undefined);
    assert.equal(r.snapshots[0].capabilities.queryIntent, true);
    assert.equal(r.counts.adapter, 2);
    assert.deepEqual(r.baseBatches, [1]);
    assert.deepEqual(r.actionBatches, [1]);
  },
);
