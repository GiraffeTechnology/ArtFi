// All execution and chain evidence in this file is visibly synthetic; MySQL and
// transactional isolation are real. No network signer or chain RPC is used.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePool } from "../src/mysql-pool.mjs";
import { createActionStore } from "../../../scripts/agent/action-store.mjs";
import { createActionKernel } from "../../../scripts/agent/action-kernel.mjs";
import { validateActionAuthority } from "../../../scripts/agent/action-policy.mjs";
import { INTENT_TYPES } from "../../../scripts/agent/bounded-intent.mjs";
import {
  actionFixture,
  syntheticEvidence,
  ethers,
} from "./action-fixtures.mjs";
const config = JSON.parse(
  await readFile(process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG, "utf8"),
);
assert.equal(config.database, "artfi_stage2_isolated_test");
assert.equal(config.host, "127.0.0.1");
const pool = await createDatabasePool(config),
  options = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    pool,
    leaseMs: 2000,
    operationTimeoutMs: 250,
    cleanupTimeoutMs: 50,
  },
  store = createActionStore(options);
test.after(async () => pool.end());
function runtime(
  f,
  {
    loseResponse = false,
    unproven = false,
    observePatch = {},
    runtimeStore = store,
  } = {},
) {
  let sends = 0;
  const evidence = new Map(),
    filled = new Map();
  const tick = createActionKernel({
    store: runtimeStore,
    authorize: f.authorize,
    adapterTimeoutMs: 150,
    observe: async (leg) =>
      f.observe(leg, {
        ...(leg.expected.name === "IntentFilled"
          ? {
              orderRemaining: (
                BigInt(leg.expected.maxAmount) -
                (filled.get(leg.orderKey) ?? 0n)
              ).toString(),
            }
          : {}),
        ...observePatch,
      }),
    execute: async (leg, context) => {
      sends++;
      const proof = syntheticEvidence(
        leg,
        context.operationId,
        context.legIndex,
      );
      if (leg.expected.name === "IntentFilled") {
        const total = (filled.get(leg.orderKey) ?? 0n) + BigInt(leg.quantity);
        assert.ok(total <= BigInt(leg.expected.maxAmount));
        filled.set(leg.orderKey, total);
        proof.events[0].args.filledToDate = total.toString();
      }
      evidence.set(`${context.operationId}:${context.legIndex}`, proof);
      if (loseResponse) throw Error("TEST_ADAPTER_RESPONSE_LOST");
      return leg.dispatch.kind === "SIGNED_ORDER_PUBLICATION"
        ? { orderHash: leg.orderKey }
        : { transactionHash: proof.transaction.hash };
    },
    readEvidence: async (leg, row) =>
      unproven ? null : evidence.get(`${row.id}:${row.cursor}`),
  });
  return {
    tick,
    evidence,
    sends: () => sends,
    setEvidence: (id, index, proof) => evidence.set(`${id}:${index}`, proof),
  };
}

test("real MySQL multiple partial fills consume one shared signed intent to exact boundaries", async () => {
  const f = await actionFixture({
      intentPatch: {
        maxExecutions: "3",
        maxAggregateExposure: "100",
        maxTransactionValue: "50",
      },
    }),
    quote = await f.order();
  const run = runtime(f);
  for (const quantity of ["2", "3", "5"]) {
    const plan = f.compile({ ...quote, quantity });
    await store.prepare(f.verified, plan);
    assert.equal((await run.tick(plan.operationId)).state, "COMPLETED");
  }
  const fourth = f.compile({
    ...(await f.order({ salt: "2" })),
    quantity: "1",
  });
  await store.prepare(f.verified, fourth);
  const refused = await run.tick(fourth.operationId);
  assert.equal(refused.state, "REJECTED");
  assert.equal(run.sends(), 3);
  const budget = await store.getBudgets(fourth.operationId);
  assert.equal(budget.authority.executions, "3");
  assert.equal(budget.wallet.reservedValue, "100");
  assert.equal(budget.wallet.learning.authority, "ADVISORY_ONLY");
  assert.equal(budget.wallet.learning.samples, 3);
  assert.deepEqual((await store.get(fourth.operationId)).envelope, f.envelope);
});
test("concurrent operations cannot exceed a shared execution or exposure limit", async () => {
  const f = await actionFixture({
      intentPatch: { maxExecutions: "1", maxAggregateExposure: "10" },
    }),
    quote = await f.order();
  const a = f.compile({ ...quote, quantity: "1" }),
    b = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, a);
  await store.prepare(f.verified, b);
  const run = runtime(f);
  const results = await Promise.all([
    run.tick(a.operationId),
    run.tick(b.operationId),
  ]);
  assert.equal(results.filter((x) => x.state === "COMPLETED").length, 1);
  assert.equal(run.sends(), 1);
  assert.equal(
    (await store.getBudgets(a.operationId)).wallet.reservedValue,
    "10",
  );
});
test("a new operation cannot replace the authority envelope sharing its nonce", async () => {
  const f = await actionFixture(),
    quote = await f.order(),
    a = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, a);
  const intent = { ...f.envelope.intent, maxAggregateExposure: "99999" },
    envelope = {
      ...f.envelope,
      intent,
      signature: await f.user.signTypedData(
        f.envelope.domain,
        INTENT_TYPES,
        intent,
      ),
    };
  const widened = validateActionAuthority(envelope, {
    ethers,
    policy: f.policy,
  });
  await assert.rejects(
    store.prepare(widened, f.compile({ ...quote, quantity: "1" })),
    /AUTHORITY_NONCE_CONFLICT/,
  );
  await assert.rejects(
    store.prepare(f.verified, {
      ...a,
      operationId: a.operationId,
      request: { ...a.request, action: "BUY" },
    }),
    /ACTION_PREPARE_INVALID/,
  );
});
test("UNKNOWN keeps all budgets after a fresh pool and reconciles without resending", async () => {
  const f = await actionFixture({
      intentPatch: { maxExecutions: "2", maxAggregateExposure: "10" },
    }),
    quote = await f.order(),
    a = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, a);
  const run = runtime(f, { loseResponse: true });
  assert.equal((await run.tick(a.operationId)).state, "SAFE_DEGRADED");
  const budget = await store.getBudgets(a.operationId);
  assert.equal(budget.authority.executions, "1");
  assert.equal(budget.wallet.reservedValue, "10");
  const b = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, b);
  assert.equal((await run.tick(b.operationId)).state, "REJECTED");
  assert.equal(run.sends(), 1);
  const pool2 = await createDatabasePool(config);
  try {
    const restarted = createActionStore({ ...options, pool: pool2 });
    let resent = 0;
    const tick = createActionKernel({
      store: restarted,
      authorize: () => {
        throw Error("UNEXPECTED_POLICY");
      },
      observe: () => {
        throw Error("UNEXPECTED_SOURCE");
      },
      execute: async () => {
        resent++;
      },
      readEvidence: async (leg, row) =>
        run.evidence.get(`${row.id}:${row.cursor}`),
      adapterTimeoutMs: 150,
    });
    assert.equal((await tick(a.operationId)).state, "COMPLETED");
    assert.equal(resent, 0);
    assert.equal(
      (await restarted.getBudgets(a.operationId)).wallet.reservedValue,
      "10",
    );
  } finally {
    await pool2.end();
  }
});
test("an unconfirmed cancellation holds its open-order slot; canonical proof releases it once", async () => {
  const f = await actionFixture({
      action: "CREATE_ORDER",
      intentPatch: { maxOpenOrders: "1" },
    }),
    original = await f.order({ owner: f.user }),
    created = f.compile(original),
    run = runtime(f);
  await store.prepare(f.verified, created);
  assert.equal((await run.tick(created.operationId)).state, "COMPLETED");
  assert.equal(
    (await store.getBudgets(created.operationId)).wallet.openOrders,
    "1",
  );
  const second = f.compile(await f.order({ owner: f.user, salt: "2" }));
  await store.prepare(f.verified, second);
  assert.equal((await run.tick(second.operationId)).state, "REJECTED");
  const cancel = f.compile(original, { action: "CANCEL_ORDER" });
  await store.prepare(f.verified, cancel);
  const lost = runtime(f, { loseResponse: true });
  assert.equal((await lost.tick(cancel.operationId)).state, "SAFE_DEGRADED");
  assert.equal(
    (await store.getBudgets(cancel.operationId)).wallet.openOrders,
    "1",
  );
  assert.equal((await lost.tick(cancel.operationId)).state, "COMPLETED");
  assert.equal(
    (await store.getBudgets(cancel.operationId)).wallet.openOrders,
    "0",
  );
  assert.equal((await lost.tick(cancel.operationId)).state, "COMPLETED");
  assert.equal(
    (await store.getBudgets(cancel.operationId)).wallet.openOrders,
    "0",
  );
  const third = f.compile(await f.order({ owner: f.user, salt: "3" }));
  await store.prepare(f.verified, third);
  assert.equal((await run.tick(third.operationId)).state, "COMPLETED");
});
test("AMEND stops after unknown retirement and only publishes after canonical retirement", async () => {
  const f = await actionFixture({
      action: "AMEND_ORDER",
      intentPatch: { maxExecutions: "2", maxOpenOrders: "1" },
    }),
    original = await f.order({ owner: f.user }),
    replacement = await f.order({ owner: f.user, salt: "2" }),
    plan = f.compile({ original, replacement });
  await store.prepare(f.verified, plan);
  const run = runtime(f, { loseResponse: true });
  assert.equal((await run.tick(plan.operationId)).state, "SAFE_DEGRADED");
  assert.equal(run.sends(), 1);
  assert.equal((await store.get(plan.operationId)).cursor, 0);
  assert.equal((await run.tick(plan.operationId)).state, "PLANNED");
  assert.equal(run.sends(), 1);
  assert.equal((await store.get(plan.operationId)).cursor, 1);
  assert.equal((await run.tick(plan.operationId)).state, "SAFE_DEGRADED");
  assert.equal(run.sends(), 2);
  assert.equal((await run.tick(plan.operationId)).state, "COMPLETED");
  assert.equal(run.sends(), 2);
  const budget = await store.getBudgets(plan.operationId);
  assert.equal(budget.authority.executions, "2");
  assert.equal(budget.wallet.openOrders, "1");
  const events = await store.history(plan.operationId);
  assert.ok(events.some((x) => x.leg === "RETIRE" && x.state === "COMPLETED"));
  assert.ok(events.some((x) => x.leg === "REPLACE" && x.state === "COMPLETED"));
  assert.ok(
    events.findIndex((x) => x.leg === "RETIRE" && x.state === "COMPLETED") <
      events.findIndex((x) => x.leg === "REPLACE" && x.state === "STARTED"),
  );
});
test("action rate limits are durable and do not become free executions on restart", async () => {
  const f = await actionFixture();
  f.policy.maxActionsPerMinute = 1;
  const { createActionPolicy } =
    await import("../../../scripts/agent/action-policy.mjs");
  f.authorize = createActionPolicy({ ethers, policy: f.policy });
  const quote = await f.order(),
    a = f.compile({ ...quote, quantity: "1" }),
    b = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, a);
  await store.prepare(f.verified, b);
  const run = runtime(f);
  assert.equal((await run.tick(a.operationId)).state, "COMPLETED");
  assert.equal((await run.tick(b.operationId)).reason, "ACTION_RATE_LIMITED");
  assert.equal(run.sends(), 1);
  assert.equal((await store.getBudgets(b.operationId)).wallet.windowCount, 1);
});
test("recovery during source failure preserves historical settlement and blocks only new RWA activity", async () => {
  const f = await actionFixture(),
    quote = await f.order(),
    a = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, a);
  const run = runtime(f, {
    loseResponse: true,
    observePatch: { groundingCurrent: true },
  });
  assert.equal((await run.tick(a.operationId)).state, "SAFE_DEGRADED");
  const b = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, b);
  const unavailable = runtime(f, {
    observePatch: { groundingCurrent: false, approvedSourceCurrent: false },
  });
  assert.equal((await unavailable.tick(b.operationId)).state, "SAFE_DEGRADED");
  assert.equal(unavailable.sends(), 0);
  unavailable.setEvidence(
    a.operationId,
    0,
    run.evidence.get(`${a.operationId}:0`),
  );
  assert.equal((await unavailable.tick(a.operationId)).state, "COMPLETED");
  assert.equal(unavailable.sends(), 0);
});

test("autonomous planner resumes from durable intent, rejects unsafe advice, and prepares one next bounded workflow", async () => {
  const { createAdvisoryPlanner } =
    await import("../../../scripts/agent/advisory-planner.mjs");
  const { compileStage1Action } =
    await import("../../../scripts/agent/stage1-action-plans.mjs");
  const f = await actionFixture({
      intentPatch: { maxExecutions: "2", maxAggregateExposure: "20" },
    }),
    quote = await f.order(),
    first = f.compile({ ...quote, quantity: "1" }),
    run = runtime(f);
  await store.prepare(f.verified, first);
  assert.equal((await run.tick(first.operationId)).state, "COMPLETED");
  const candidate = f.compile({ ...quote, quantity: "1" });
  const planner = createAdvisoryPlanner({
    store,
    ethers,
    policy: f.policy,
    authorize: f.authorize,
    observe: async (leg) => f.observe(leg),
    compile: (request) => compileStage1Action(request, { ethers }),
    readCandidates: async (authority) =>
      authority.intent.wallet.toLowerCase() === f.user.address.toLowerCase()
        ? [
            {
              status: "CURRENT",
              sourceId: "ISOLATED_OPPORTUNITIES",
              observedAt: Date.now(),
              request: candidate.request,
            },
          ]
        : [],
    advise: async () => ["CONSTITUTIONAL_CHANGE_NOT_A_CANDIDATE"],
  });
  let prepared = 0;
  for (let i = 0; i < 30 && !prepared; i++) {
    const batch = await planner.runBatch(new AbortController().signal);
    prepared += batch.prepared;
  }
  assert.equal(prepared, 1);
  const pending = await store.listPending({ limit: 100 }),
    next = pending.find((row) => row.authorityKey === f.verified.authorityKey);
  assert.ok(next);
  assert.match(next.id, /^auto-/);
  assert.equal((await run.tick(next.id)).state, "COMPLETED");
  assert.equal(run.sends(), 2);
  assert.equal((await store.getBudgets(next.id)).authority.executions, "2");
  for (let i = 0; i < 4; i++)
    await planner.runBatch(new AbortController().signal);
  assert.equal(
    (await store.listPending({ limit: 100 })).some(
      (row) => row.authorityKey === f.verified.authorityKey,
    ),
    false,
  );
});

test("stored TEST_ONLY authority cannot be silently promoted into a configured bounded profile", async () => {
  const { compileStage1Action } =
    await import("../../../scripts/agent/stage1-action-plans.mjs");
  const f = await actionFixture(),
    quote = await f.order(),
    initial = f.compile({ ...quote, quantity: "1" });
  await store.prepare(f.verified, initial);
  const bounded = createActionStore({
    ...options,
    mode: "BOUNDED_SIGNED_AUTHORITY",
  });
  const next = compileStage1Action(
    { ...initial.request, operationId: initial.operationId + "-configured" },
    { ethers, mode: "BOUNDED_SIGNED_AUTHORITY" },
  );
  await assert.rejects(
    bounded.prepare(f.verified, next),
    /AUTHORITY_NONCE_CONFLICT/,
  );
  await assert.rejects(
    bounded.get(initial.operationId),
    /ACTION_PROFILE_MISMATCH/,
  );
});
