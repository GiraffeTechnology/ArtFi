import test from "node:test";
import assert from "node:assert/strict";
import { actionFixture, ethers } from "./action-fixtures.mjs";
import { createAdvisoryPlanner } from "../../../scripts/agent/advisory-planner.mjs";

test("A3 advisory model outage falls back to deterministic in-bound plan generation", async () => {
  const f = await actionFixture(),
    valid = f.compile({ ...(await f.order()), quantity: "1" }),
    over = f.compile({ ...(await f.order()), quantity: "10" });
  const prepared = [];
  const store = {
    listPlannable: async () => [
      { authorityKey: f.verified.authorityKey, envelope: f.envelope },
    ],
    get: async () => null,
    prepare: async (...args) => prepared.push(args),
  };
  const { compileStage1Action } =
    await import("../../../scripts/agent/stage1-action-plans.mjs");
  const planner = createAdvisoryPlanner({
    store,
    ethers,
    policy: f.policy,
    authorize: f.authorize,
    observe: async (leg) => f.observe(leg),
    compile: (request) => compileStage1Action(request, { ethers }),
    readCandidates: async () =>
      [over, valid].map((plan) => ({
        sourceId: "TEST_ONLY_SOURCE",
        status: "CURRENT",
        observedAt: Date.now(),
        request: plan.request,
      })),
    advise: async () => {
      throw Error("TEST_MODEL_UNAVAILABLE");
    },
  });
  const report = await planner.runBatch(new AbortController().signal);
  assert.equal(report.prepared, 1);
  assert.equal(report.advisoryFallback, true);
  assert.equal(prepared[0][1].legs[0].value, "10");
  assert.equal(prepared[0][0].digest, f.verified.digest);
  assert.match(prepared[0][1].operationId, /^auto-/);
});
test("A3 model cannot inject a new action or alter an existing signed envelope", async () => {
  const f = await actionFixture({ intentPatch: { maxTransactionValue: "10" } }),
    valid = f.compile({ ...(await f.order()), quantity: "1" }),
    over = f.compile({ ...(await f.order()), quantity: "2" }),
    prepared = [];
  const { compileStage1Action } =
    await import("../../../scripts/agent/stage1-action-plans.mjs");
  const planner = createAdvisoryPlanner({
    store: {
      listPlannable: async () => [
        { authorityKey: f.verified.authorityKey, envelope: f.envelope },
      ],
      get: async () => null,
      prepare: async (...args) => prepared.push(args),
    },
    ethers,
    policy: f.policy,
    authorize: f.authorize,
    observe: async (leg) => f.observe(leg),
    compile: (request) => compileStage1Action(request, { ethers }),
    readCandidates: async () =>
      [valid, over].map((plan) => ({
        sourceId: "TEST_ONLY_SOURCE",
        status: "CURRENT",
        observedAt: Date.now(),
        request: plan.request,
      })),
    advise: async () => ["UPGRADE_CONTRACT", "arbitrary-new-operation"],
  });
  const report = await planner.runBatch(new AbortController().signal);
  assert.equal(report.prepared, 1);
  assert.equal(report.rejected, 1);
  assert.deepEqual(prepared[0][0].envelope, f.envelope);
});
