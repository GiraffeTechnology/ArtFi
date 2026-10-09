// Real isolated MySQL integration. This file never starts a chain, signs or broadcasts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePool } from "../src/mysql-pool.mjs";
import { createDurableStore } from "../../../scripts/agent/durable-store.mjs";
import {
  createAgentKernel,
  kernelRequestDigest,
} from "../../../scripts/agent/agent-kernel.mjs";
import { createRecoveryWorker } from "../../../scripts/agent/recovery-worker.mjs";

const mode = "TEST_ONLY_NO_REAL_VALUE";
const path = process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG;
assert.ok(
  path,
  "Use scripts/agent/test-mysql.sh. No existing database is a default.",
);
const config = JSON.parse(await readFile(path, "utf8"));
assert.equal(config.database, "artfi_stage2_isolated_test");
assert.equal(config.host, "127.0.0.1");
const pool = await createDatabasePool(config);
const options = {
  mode,
  pool,
  leaseMs: 1800,
  operationTimeoutMs: 200,
  cleanupTimeoutMs: 50,
};
const store = createDurableStore(options);
const addr = (x) => `0x${x.repeat(40)}`;
const hash = (x) => `0x${x.repeat(64)}`;
let counter = 0;
function request(overrides = {}) {
  const n = ++counter;
  return {
    operationId: `mysql-operation-${String(n).padStart(4, "0")}`,
    authorityVersion: "test-observation-1",
    execution: { chainId: "560048", executor: addr("a") },
    intent: {
      wallet: addr("b"),
      nonce: String(n),
      intentId: "0x" + n.toString(16).padStart(64, "0"),
      actionScope: "1",
      maxExecutions: "1",
      maxOpenOrders: "0",
      maxAggregateExposure: "100000",
    },
    sale: { nft: addr("c"), price: "10" },
    ...overrides,
  };
}
const started = (req, overrides = {}) => ({
  state: "STARTED",
  authorityVersion: "test-observation-2",
  intentDigest: hash("d"),
  reservedValue: req.sale.price,
  observedAggregateExposure: "0",
  recoveryAttempts: 0,
  ...overrides,
});
const kernelFor = (overrides = {}, runtimeStore = store) =>
  createAgentKernel({
    mode,
    store: runtimeStore,
    adapterTimeoutMs: 100,
    mintAuthority: async (req) => ({
      status: "EXCLUSIVE_AT_PINNED_BLOCK",
      productionApproved: false,
      chainId: "560048",
      nft: req.sale.nft,
      consumer: addr("d"),
      policy: addr("e"),
      blockNumber: 1,
      blockHash: hash("a"),
      requestedBlockNumber: 1,
      requestedBlockHash: hash("a"),
    }),
    observe: async () => ({ available: true, current: true }),
    authorize: async (req) => ({
      state: "AUTHORIZED_NOT_EXECUTED",
      intentDigest: hash("d"),
      stateVersion: "test-observation-2",
      value: req.sale.price,
      observedAggregateExposure: "0",
    }),
    execute: async () => ({ transactionHash: hash("f"), testOnly: true }),
    verify: async () => ({ state: "CONFIRMED" }),
    reconcile: async () => ({
      state: "SETTLED",
      canonical: true,
      accountingMatches: true,
    }),
    ...overrides,
  });

test.after(async () => {
  await pool.end();
});

test("real MySQL create is idempotent and changed body never replaces signed identity", async () => {
  const req = request();
  const created = await store.prepare(req);
  assert.equal(created.state, "PREPARED");
  assert.deepEqual((await store.prepare(req)).request, req);
  await assert.rejects(
    store.prepare({ ...req, sale: { ...req.sale, price: "11" } }),
    /IMMUTABLE_REQUEST_CONFLICT/,
  );
  const events = await store.listEvents(req.operationId);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "PREPARED");
  assert.equal(events[0].mode, mode);
});

test("MySQL serializes concurrent leases and refuses stale version/token CAS", async () => {
  const req = request();
  await store.prepare(req);
  const claims = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.claim(req.operationId, kernelRequestDigest(req)),
    ),
  );
  const claimed = claims.filter(Boolean);
  assert.equal(claimed.length, 1);
  const row = claimed[0];
  await assert.rejects(
    store.transition(row.id, row.version - 1, started(req), row.leaseToken),
    /DURABLE_CAS_REFUSED/,
  );
  await assert.rejects(
    store.transition(row.id, row.version, started(req), "wrong-lease"),
    /DURABLE_CAS_REFUSED/,
  );
  await store.release(row.id, row.leaseToken);
});

test("atomic exposure and nonce reservation survive replay with a different operation ID", async () => {
  const req = request();
  await store.prepare(req);
  const a = await store.claim(req.operationId, kernelRequestDigest(req));
  await store.transition(a.id, a.version, started(req), a.leaseToken);
  await store.release(a.id, a.leaseToken);
  const duplicate = { ...req, operationId: `${req.operationId}-replay` };
  await store.prepare(duplicate);
  const b = await store.claim(
    duplicate.operationId,
    kernelRequestDigest(duplicate),
  );
  await assert.rejects(
    store.transition(b.id, b.version, started(duplicate), b.leaseToken),
    /AUTHORITY_ALREADY_RESERVED/,
  );
  assert.equal((await store.get(b.id)).state, "PREPARED");
  await store.release(b.id, b.leaseToken);
});

test("full kernel persists STARTED, audit and canonical settlement once", async () => {
  const req = request();
  await store.prepare(req);
  let sends = 0;
  const kernel = kernelFor({
    execute: async () => {
      sends++;
      return { transactionHash: hash("e") };
    },
  });
  assert.equal((await kernel(req)).state, "SETTLED");
  assert.equal((await kernel(req)).state, "SETTLED");
  assert.equal(sends, 1);
  const events = await store.listEvents(req.operationId);
  assert.deepEqual(
    events.map((x) => x.state),
    ["PREPARED", "PREPARED", "STARTED", "SUBMITTED", "CONFIRMED", "SETTLED"],
  );
  assert.equal(
    events.some((x) => JSON.stringify(x).includes("Signature")),
    false,
  );
  assert.deepEqual(
    await store.listEvents(req.operationId, { after: events.at(-1).id }),
    [],
  );
});

test("process crash after durable STARTED recovers by durable scan without a second dispatch", async () => {
  const req = request();
  await store.prepare(req);
  const child = spawn(
    process.execPath,
    [
      new URL("./mysql-crash-worker.mjs", import.meta.url).pathname,
      req.operationId,
    ],
    {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const deadline = Date.now() + 10000;
  while (
    !stdout.includes("TEST_STARTED_DURABLE") &&
    Date.now() < deadline &&
    child.exitCode === null
  )
    await delay(10);
  assert.ok(stdout.includes("TEST_STARTED_DURABLE"), `child failed: ${stderr}`);
  child.kill("SIGKILL");
  assert.equal((await closed).signal, "SIGKILL");
  assert.equal((await store.get(req.operationId)).state, "STARTED");
  await delay(1900);
  let sends = 0,
    reconciles = 0;
  const restartedPool = await createDatabasePool(config);
  try {
    const restartedStore = createDurableStore({
      ...options,
      pool: restartedPool,
    });
    const tick = kernelFor(
      {
        execute: async () => {
          sends++;
          throw Error("UNEXPECTED_TEST_SEND");
        },
        mintAuthority: async () => {
          throw Error("UNEXPECTED_TEST_NEW_AUTHORITY");
        },
        reconcile: async (row) => {
          if (row.id === req.operationId) reconciles++;
          return { state: "SETTLED", canonical: true, accountingMatches: true };
        },
      },
      restartedStore,
    );
    const worker = createRecoveryWorker({ mode, store: restartedStore, tick });
    await worker.runBatch(new AbortController().signal);
    assert.equal((await restartedStore.get(req.operationId)).state, "SETTLED");
    assert.equal(sends, 0);
    assert.equal(reconciles, 1);
  } finally {
    await restartedPool.end();
  }
});

test("adapter timeout preserves durable reservation and later reconciliation never resends", async () => {
  const req = request();
  await store.prepare(req);
  let sends = 0;
  const kernel = kernelFor({
    execute: async () => {
      sends++;
      await delay(180);
      return { transactionHash: hash("e") };
    },
  });
  assert.equal((await kernel(req)).state, "SAFE_DEGRADED");
  await delay(200);
  assert.equal((await kernel(req)).state, "SETTLED");
  assert.equal(sends, 1);
});

test("revocation is durably identity-bound and survives a fresh driver pool", async () => {
  const req = request();
  await store.prepare(req);
  const proof = {
    transactionHash: hash("e"),
    wallet: req.intent.wallet,
    nonce: req.intent.nonce,
    executor: req.execution.executor,
    chainId: "560048",
    state: "CONFIRMED",
    canonical: true,
  };
  await store.noteRevocation(req.operationId, req.intent.wallet, proof);
  const otherPool = await createDatabasePool(config);
  try {
    const other = createDurableStore({ ...options, pool: otherPool });
    assert.deepEqual((await other.get(req.operationId)).revocation, proof);
    let sends = 0;
    assert.equal(
      (
        await kernelFor(
          {
            execute: async () => {
              sends++;
            },
          },
          other,
        )(req)
      ).state,
      "TERMINAL_REJECTED",
    );
    assert.equal(sends, 0);
  } finally {
    await otherPool.end();
  }
});

test("real database shutdown/restart safely degrades then reconnects and reconciles reserved operation", async () => {
  const req = request();
  await store.prepare(req);
  const row = await store.claim(req.operationId, kernelRequestDigest(req));
  await store.transition(row.id, row.version, started(req), row.leaseToken);
  await store.release(row.id, row.leaseToken);
  const control = process.env.ARTFI_AGENT_TEST_MYSQL_CONTROL;
  assert.ok(control);
  const run = (action) =>
    new Promise((resolve, reject) => {
      const child = spawn("bash", [control, action], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stderr.on("data", (x) => (output += x));
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`isolated database ${action} failed: ${output}`)),
      );
    });
  let sends = 0;
  const tick = kernelFor({
    execute: async () => {
      sends++;
    },
  });
  await run("stop");
  const degraded = await tick(req);
  assert.equal(degraded.state, "SAFE_DEGRADED");
  assert.equal(degraded.executionAttempted, false);
  await run("start");
  const deadline = Date.now() + 10000;
  let result;
  while (Date.now() < deadline) {
    result = await tick(req);
    if (result.state === "SETTLED") break;
    await delay(200);
  }
  assert.equal(result?.state, "SETTLED");
  assert.equal(sends, 0);
  assert.equal((await store.get(req.operationId)).state, "SETTLED");
});
