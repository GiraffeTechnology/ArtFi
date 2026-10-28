import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createActionKernel } from "../../../scripts/agent/action-kernel.mjs";

function fixture() {
  let row = {
    id: "test",
    authorityKey: "authority",
    envelope: {},
    intentDigest: "digest",
    plan: { digest: "plan", legs: [{}] },
    cursor: 0,
    legs: [{ state: "PLANNED" }],
    state: "PLANNED",
    version: 1,
    leaseToken: "TEST_ONLY",
    leaseExpiresAt: Date.now() + 10000,
  };
  const calls = { sends: 0, releases: 0, rejects: 0, degrades: 0 };
  const change = (state) => (row = { ...row, state, version: row.version + 1 });
  const store = {
    leaseDurationMs: 10000,
    operationTimeoutMs: 250,
    totalOperationTimeoutMs: 400,
    claim: async () => row,
    renew: async () =>
      (row = { ...row, leaseExpiresAt: row.leaseExpiresAt + 1 }),
    startLeg: async () => change("STARTED"),
    submitted: async () => change("SUBMITTED"),
    completeLeg: async () => change("COMPLETED"),
    degrade: async () => {
      calls.degrades++;
      return change("SAFE_DEGRADED");
    },
    reject: async () => {
      calls.rejects++;
      return change("REJECTED");
    },
    release: async () => {
      calls.releases++;
    },
  };
  const config = {
    store,
    adapterTimeoutMs: 10,
    authorize: async () => ({ intentDigest: "digest" }),
    observe: async () => ({}),
    execute: async () => {
      calls.sends++;
      return {};
    },
    readEvidence: async () => null,
  };
  return {
    store,
    config,
    calls,
    terminal: () => {
      row.state = "COMPLETED";
    },
  };
}

test("store claim can finish after adapter deadline within its own budget", async () => {
  const f = fixture();
  f.terminal();
  const claim = f.store.claim;
  f.store.claim = async () => {
    await delay(60);
    return claim();
  };
  assert.equal((await createActionKernel(f.config)("test")).state, "COMPLETED");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 1);
});
test("rolled-back store refusal preserves classification after adapter deadline", async () => {
  const f = fixture();
  f.store.startLeg = async () => {
    await delay(60);
    throw Object.assign(Error("EXPOSURE_EXCEEDED"), {
      transactionOutcome: "ROLLED_BACK",
    });
  };
  const r = await createActionKernel(f.config)("test");
  assert.equal(r.state, "REJECTED");
  assert.equal(r.reason, "EXPOSURE_EXCEEDED");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.rejects, 1);
  assert.equal(f.calls.releases, 1);
});
test("unknown store commit retains lease and never dispatches or retries", async () => {
  const f = fixture();
  let claimed = false;
  const claim = f.store.claim;
  f.store.claim = async () => {
    if (claimed) return null;
    claimed = true;
    return claim();
  };
  f.store.startLeg = async () => {
    throw Object.assign(Error("DURABLE_COMMIT_TIMEOUT"), {
      transactionOutcome: "COMMIT_UNKNOWN",
    });
  };
  const tick = createActionKernel(f.config),
    r = await tick("test");
  assert.equal(r.state, "SAFE_DEGRADED");
  assert.equal(r.reason, "DURABLE_COMMIT_TIMEOUT");
  assert.equal(r.storeOutcome, "UNKNOWN");
  assert.equal(f.calls.releases, 0);
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.degrades, 0);
  assert.equal((await tick("test")).state, "BUSY");
});
test("adapter timeout still aborts at its own budget and no late dispatch occurs", async () => {
  const f = fixture();
  let signal;
  f.config.observe = async (_leg, _row, s) => {
    signal = s;
    await delay(60);
    return {};
  };
  const r = await createActionKernel(f.config)("test");
  assert.equal(r.state, "SAFE_DEGRADED");
  assert.equal(r.reason, "ACTION_ADAPTER_TIMEOUT");
  assert.equal(signal.aborted, true);
  await delay(70);
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.degrades, 1);
});
test("store acquisition failure remains fail closed without dispatch", async () => {
  const f = fixture();
  f.store.claim = async () => {
    throw Error("DURABLE_ACQUIRE_TIMEOUT");
  };
  const r = await createActionKernel(f.config)("test");
  assert.equal(r.state, "SAFE_DEGRADED");
  assert.equal(r.reason, "DURABLE_STORE_UNAVAILABLE");
  assert.equal(f.calls.sends, 0);
});

test("real durable store bounds a hanging acquisition and destroys its late connection", async () => {
  const { createActionStore } =
    await import("../../../scripts/agent/action-store.mjs");
  const f = fixture();
  let resolveConnection,
    destroyed = 0,
    released = 0;
  const pending = new Promise((resolve) => {
    resolveConnection = resolve;
  });
  const real = createActionStore({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    pool: { getConnection: () => pending },
    leaseMs: 10000,
    operationTimeoutMs: 30,
    cleanupTimeoutMs: 10,
  });
  const result = await createActionKernel({ ...f.config, store: real })("test");
  assert.equal(result.state, "SAFE_DEGRADED");
  assert.equal(result.reason, "DURABLE_STORE_UNAVAILABLE");
  assert.equal(f.calls.sends, 0);
  resolveConnection({
    destroy: () => {
      destroyed++;
    },
    release: () => {
      released++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
  assert.equal(f.calls.sends, 0);
});

test("missing or invalid store budget is rejected instead of silently defaulting", () => {
  for (const budget of [undefined, NaN, Infinity, 9, 33001]) {
    const f = fixture();
    f.store.totalOperationTimeoutMs = budget;
    assert.throws(
      () => createActionKernel(f.config),
      /ACTION_KERNEL_CONFIGURATION_INVALID/,
    );
  }
});
test("declared but hanging store claim is bounded without sending", async () => {
  const f = fixture();
  f.store.operationTimeoutMs = 10;
  f.store.totalOperationTimeoutMs = 30;
  f.store.claim = () => new Promise(() => {});
  const r = await createActionKernel(f.config)("test");
  assert.equal(r.state, "SAFE_DEGRADED");
  assert.equal(r.reason, "DURABLE_STORE_UNAVAILABLE");
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 0);
});
test("late mutation after store watchdog stays unknown and cannot resume dispatch", async () => {
  const f = fixture();
  f.store.operationTimeoutMs = 10;
  f.store.totalOperationTimeoutMs = 30;
  let resolveMutation;
  const start = f.store.startLeg;
  f.store.startLeg = () =>
    new Promise((resolve) => {
      resolveMutation = resolve;
    });
  const r = await createActionKernel(f.config)("test");
  assert.equal(r.state, "SAFE_DEGRADED");
  assert.equal(r.reason, "ACTION_STORE_TIMEOUT");
  assert.equal(r.storeOutcome, "UNKNOWN");
  assert.equal(f.calls.releases, 0);
  assert.equal(f.calls.sends, 0);
  resolveMutation(await start());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.sends, 0);
  assert.equal(f.calls.releases, 0);
  assert.equal(f.calls.degrades, 0);
});
test("lease validation includes complete store cleanup budget", () => {
  const f = fixture();
  f.store.leaseDurationMs = 1600;
  assert.throws(
    () => createActionKernel(f.config),
    /ACTION_KERNEL_CONFIGURATION_INVALID/,
  );
});
