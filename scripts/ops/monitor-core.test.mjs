import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor, evaluate } from "./monitor-core.mjs";

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-monitor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    directory,
    environment: "test",
    checks: [{ id: "market-api", category: "api", maxAgeMs: 1000 }],
    now: () => 10000,
    timeoutMs: 15,
    threshold: 1,
    probe: async () => ({ observedAt: 10000, available: false }),
    ...extra,
  };
  return { directory, config, monitor: new Monitor(config) };
}

test("freshness requires a current, explicit healthy sample", () => {
  assert.equal(
    evaluate({ available: true, observedAt: 0, fresh: true }, 10000, 1000),
    "unknown",
  );
  assert.equal(
    evaluate({ available: true, observedAt: 10000 }, 10000, 1000),
    "stale",
  );
  assert.equal(
    evaluate({ available: true, observedAt: 10001, fresh: true }, 10000, 1000),
    "unknown",
  );
  assert.equal(
    evaluate({ available: true, observedAt: 10000, fresh: true }, 10000, 1000),
    "healthy",
  );
});
test("model outage cannot stop monitoring or durable escalation", async (t) => {
  const { monitor, directory } = await fixture(t, {
    classify: async () => {
      throw Error("secret");
    },
  });
  const state = await monitor.tick();
  assert.equal(state.queue[0].model, "unavailable");
  assert.equal(state.queue[0].delivery, "pending");
  assert.equal(state.heartbeatAt, 10000);
  assert.ok(
    !(await readFile(join(directory, "monitor-state.json"), "utf8")).includes(
      "secret",
    ),
  );
});
test("restart deduplicates outage and emits a recovery once", async (t) => {
  const { config, monitor } = await fixture(t);
  await monitor.tick();
  assert.equal((await new Monitor(config).tick()).queue.length, 1);
  config.probe = async () => ({
    observedAt: 10000,
    available: true,
    fresh: true,
  });
  const recovered = await new Monitor(config).tick();
  assert.equal(recovered.queue.length, 2);
  assert.equal(recovered.queue[1].type, "recovery");
  assert.equal((await new Monitor(config).tick()).queue.length, 2);
});
test("model sees only safe labels; injected commands are ignored", async (t) => {
  let sent;
  const { monitor } = await fixture(t, {
    probe: async () => ({
      observedAt: 10000,
      available: false,
      body: "private customer text",
    }),
    classify: async (value) => {
      sent = value;
      return { recommendation: "rm -rf /" };
    },
  });
  assert.equal((await monitor.tick()).queue[0].recommendation, "human-review");
  assert.deepEqual(sent, {
    category: "api",
    status: "unavailable",
    type: "incident",
  });
});
test("hanging model is bounded and does not suppress notifier", async (t) => {
  let calls = 0;
  const { monitor } = await fixture(t, {
    classify: () => new Promise(() => {}),
    notify: async (event) => {
      calls++;
      return { id: event.id, accepted: true };
    },
  });
  assert.equal((await monitor.tick()).queue[0].delivery, "delivered");
  assert.equal(calls, 1);
});
test("notification failures stop at the configured retry bound", async (t) => {
  let calls = 0;
  const { monitor } = await fixture(t, {
    maxDeliveryAttempts: 2,
    notify: async () => {
      calls++;
      throw Error("transport");
    },
  });
  await monitor.tick();
  await monitor.tick();
  const state = await monitor.tick();
  assert.equal(calls, 2);
  assert.equal(state.queue[0].delivery, "needs-human");
});
test("test state cannot be reused by production", async (t) => {
  const { config, monitor } = await fixture(t);
  await monitor.tick();
  await assert.rejects(
    new Monitor({ ...config, environment: "production" }).tick(),
    /IDENTITY_REFUSED/,
  );
});
test("probe timeout becomes unknown and remains visible", async (t) => {
  const { monitor } = await fixture(t, { probe: () => new Promise(() => {}) });
  assert.equal((await monitor.tick()).queue[0].status, "unknown");
});

test("notifier cannot forward extra persisted diagnostic fields", async (t) => {
  const { config, monitor, directory } = await fixture(t);
  await monitor.tick();
  const path = join(directory, "monitor-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.queue[0].diagnostic = "TEST_ONLY_PRIVATE_FIELD";
  await writeFile(path, JSON.stringify(state));
  let sent;
  await new Monitor({
    ...config,
    notify: async (event) => {
      sent = event;
      return { id: event.id, accepted: true };
    },
  }).tick();
  assert.deepEqual(
    Object.keys(sent).sort(),
    [
      "id",
      "checkId",
      "category",
      "environment",
      "type",
      "status",
      "observedAt",
      "recommendation",
    ].sort(),
  );
  assert.ok(!JSON.stringify(sent).includes("TEST_ONLY_PRIVATE_FIELD"));
});

test("untrusted persisted event identity is rejected before optional adapters", async (t) => {
  const { config, monitor, directory } = await fixture(t);
  await monitor.tick();
  const path = join(directory, "monitor-state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.queue[0].type = "TEST_ONLY_UNAPPROVED_TEXT";
  state.queue[0].model = "not-run";
  await writeFile(path, JSON.stringify(state));
  let calls = 0;
  await assert.rejects(
    new Monitor({
      ...config,
      classify: async () => {
        calls++;
      },
      notify: async () => {
        calls++;
      },
    }).tick(),
    /QUEUE_RECORD_REFUSED/,
  );
  assert.equal(calls, 0);
});

test("configured constructor check is an own durable entry and emits its outage", async (t) => {
  const { config, monitor } = await fixture(t, {
    checks: [{ id: "constructor", category: "api", maxAgeMs: 1000 }],
  });
  const first = await monitor.tick();
  assert.equal(first.queue.length, 1);
  assert.equal(first.queue[0].checkId, "constructor");
  assert.equal(Object.hasOwn(first.checks, "constructor"), true);
  const second = await new Monitor(config).tick();
  assert.equal(second.queue.length, 1);
  assert.equal(second.queue[0].id, first.queue[0].id);
});

test("invalid restored check state is refused before probes or heartbeat rewrite", async (t) => {
  const { config, monitor, directory } = await fixture(t);
  await monitor.tick();
  const path = join(directory, "monitor-state.json");
  const valid = JSON.parse(await readFile(path, "utf8"));
  for (const bad of [
    { consecutive: "NaN", incident: null, status: "unavailable" },
    { consecutive: -1, incident: null, status: "unavailable" },
    { consecutive: 11, incident: null, status: "unavailable" },
    { consecutive: 1, incident: "invalid", status: "unavailable" },
    { consecutive: 1, incident: null, status: "invalid" },
  ]) {
    const altered = structuredClone(valid);
    altered.checks["market-api"] = bad;
    const bytes = JSON.stringify(altered);
    await writeFile(path, bytes);
    let probes = 0;
    await assert.rejects(
      new Monitor({
        ...config,
        probe: async () => {
          probes++;
        },
      }).tick(),
      /MONITOR_CHECK_STATE_REFUSED/,
    );
    assert.equal(probes, 0);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
});
