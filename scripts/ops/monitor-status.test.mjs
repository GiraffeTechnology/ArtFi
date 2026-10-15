import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Monitor } from "./monitor-core.mjs";
import {
  projectMonitorStatus,
  readMonitorStatus,
  monitorStatusCommand,
} from "./monitor-status.mjs";

const incident = "00000000-0000-4000-8000-000000000001";
const recovery = "00000000-0000-4000-8000-000000000002";
const options = { environment: "test", maxAgeMs: 1000, now: 10000 };
function state() {
  return {
    version: 1,
    environment: "test",
    heartbeatAt: 9000,
    checks: {
      api: { category: "api", status: "unavailable", consecutive: 2, incident },
    },
    queue: [
      {
        id: incident,
        checkId: "api",
        category: "api",
        environment: "test",
        type: "incident",
        status: "unavailable",
        observedAt: 8000,
        attempts: 3,
        delivery: "needs-human",
        model: "unavailable",
        recommendation: "human-review",
      },
    ],
    collection: { status: "complete" },
  };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "artfi-monitor-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("reader observes the existing engine's durable incidents without probes, delivery or writes", async (t) => {
  const dir = await directory(t);
  let probes = 0;
  let notices = 0;
  const monitor = new Monitor({
    directory: dir,
    environment: "test",
    checks: [{ id: "api", category: "api", maxAgeMs: 1000 }],
    now: () => 10000,
    threshold: 1,
    probe: async () => {
      probes++;
      return { observedAt: 10000, available: false };
    },
    notify: async () => {
      notices++;
      return { accepted: false };
    },
  });
  await monitor.tick();
  const path = join(dir, "monitor-state.json");
  const before = await readFile(path);
  const calls = [probes, notices];
  const snapshot = await readMonitorStatus(path, options);
  assert.deepEqual([probes, notices], calls);
  assert.deepEqual(await readFile(path), before);
  assert.equal(snapshot.checksWithIncidentCount, 1);
  assert.equal(snapshot.delivery.pending, 1);
  assert.equal(snapshot.events[0].attempts, 1);
  assert.equal(snapshot.heartbeat.status, "fresh");
  assert.equal(snapshot.source.bytes, before.length);
  assert.equal(
    snapshot.source.sha256,
    createHash("sha256").update(before).digest("hex"),
  );
  assert.equal(snapshot.ready, undefined);
});

test("missing, future and expired heartbeat never imply current availability", () => {
  const saved = state();
  assert.equal(projectMonitorStatus(saved, options).heartbeat.status, "fresh");
  assert.equal(
    projectMonitorStatus(saved, { ...options, now: 10001 }).heartbeat.status,
    "stale",
  );
  saved.heartbeatAt = 11000;
  assert.deepEqual(projectMonitorStatus(saved, options).heartbeat, {
    status: "unknown",
    at: 11000,
    ageMs: null,
    maxAgeMs: 1000,
  });
  delete saved.heartbeatAt;
  delete saved.collection;
  delete saved.checks.api.category;
  const legacy = projectMonitorStatus(saved, options);
  assert.equal(legacy.heartbeat.status, "unknown");
  assert.equal(legacy.collection.status, "unknown");
  assert.equal(legacy.checks[0].category, null);
});

test("capacity gaps, retained retired events and counters survive sanitized projection", () => {
  const saved = state();
  saved.checks = {};
  saved.collection = {
    status: "capacity-blocked",
    code: "MONITOR_QUEUE_CAPACITY_BLOCKED",
    blockedSince: 8000,
    lastAttemptAt: 10000,
    lastCapacityGap: { startedAt: 1000, endedAt: 2000 },
  };
  saved.retention = { expiredDelivered: 8, capacityEvictedDelivered: 3 };
  saved.queue.push({
    ...saved.queue[0],
    id: recovery,
    type: "recovery",
    status: "healthy",
    incidentId: incident,
    delivery: "delivered",
    deliveredAt: 9500,
    observedAt: 9000,
    attempts: 1,
  });
  const result = projectMonitorStatus(saved, options);
  assert.equal(result.collection.status, "capacity-blocked");
  assert.deepEqual(result.retention, saved.retention);
  assert.deepEqual(result.delivery, {
    pending: 0,
    delivered: 1,
    "needs-human": 1,
  });
  assert.equal(result.checksWithIncidentCount, 0);
  assert.equal(result.events[0].incidentId, incident);
  assert.equal(result.events[1].delivery, "needs-human");
  assert.equal(result.retainedEventCount, 2);
});

test("unknown disk fields never escape as diagnostics, paths or model output", () => {
  const saved = state();
  const privateValue = "TEST_ONLY_PRIVATE_BYTES";
  saved.diagnostic = privateValue;
  saved.checks.api.url = privateValue;
  saved.queue[0].model = privateValue;
  saved.queue[0].raw = privateValue;
  saved.collection.path = privateValue;
  const result = projectMonitorStatus(saved, options);
  assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal(result.events[0].model, undefined);
  assert.equal(saved.queue[0].raw, privateValue);
});

test("environment mismatch, corrupt state and contradictory events fail closed", () => {
  const mutations = [
    (s) => {
      s.environment = "production";
    },
    (s) => {
      s.checks = [];
    },
    (s) => {
      s.checks.api.consecutive = -1;
    },
    (s) => {
      s.checks.api.category = "secret";
    },
    (s) => {
      s.queue.push({ ...s.queue[0] });
    },
    (s) => {
      s.queue[0].type = "recovery";
    },
    (s) => {
      s.queue[0].status = "healthy";
    },
    (s) => {
      s.queue[0].deliveredAt = 9500;
    },
    (s) => {
      s.queue[0].delivery = "delivered";
    },
    (s) => {
      s.collection = { status: "capacity-blocked" };
    },
    (s) => {
      s.retention = { expiredDelivered: -1, capacityEvictedDelivered: 0 };
    },
    (s) => {
      s.heartbeatAt = "yesterday";
    },
  ];
  for (const mutate of mutations) {
    const saved = state();
    mutate(saved);
    assert.throws(
      () => projectMonitorStatus(saved, options),
      /MONITOR_STATUS_REFUSED/,
    );
  }
});

test("recent events are explicitly bounded and do not promise complete history", () => {
  const saved = state();
  saved.queue = Array.from({ length: 102 }, (_, index) => ({
    ...saved.queue[0],
    id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    observedAt: index,
  }));
  const result = projectMonitorStatus(saved, options);
  assert.equal(result.retainedEventCount, 102);
  assert.equal(result.delivery["needs-human"], 102);
  assert.equal(result.events.length, 100);
  assert.equal(result.eventsOmitted, 2);
  assert.equal(result.events[0].observedAt, 101);
  assert.equal(result.events.at(-1).observedAt, 2);
});

test("file boundaries reject absent, malformed, invalid UTF-8, oversized and non-regular input", async (t) => {
  const dir = await directory(t);
  const path = join(dir, "state.json");
  await assert.rejects(
    readMonitorStatus(path, options),
    /^Error: MONITOR_STATUS_REFUSED$/,
  );
  for (const bytes of [
    Buffer.from("{TEST_ONLY_PRIVATE_BYTES"),
    Buffer.from([0xff]),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
  ]) {
    await writeFile(path, bytes);
    await assert.rejects(
      readMonitorStatus(path, options),
      /^Error: MONITOR_STATUS_REFUSED$/,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  await assert.rejects(
    readMonitorStatus(dir, options),
    /^Error: MONITOR_STATUS_REFUSED$/,
  );
});

test(
  "Linux refuses a symlink rather than following another state file",
  { skip: process.platform !== "linux" },
  async (t) => {
    const dir = await directory(t);
    const target = join(dir, "target.json");
    const link = join(dir, "link.json");
    await writeFile(target, JSON.stringify(state()));
    await symlink(target, link);
    await assert.rejects(
      readMonitorStatus(link, options),
      /^Error: MONITOR_STATUS_REFUSED$/,
    );
  },
);

test("CLI requires explicit environment and age; sanitized failure and success are inspection results", async () => {
  let reads = 0;
  const output = [];
  const errors = [];
  const io = {
    out: (s) => output.push(s),
    error: (s) => errors.push(s),
    read: async (path, opts) => {
      reads++;
      assert.equal(path, "private.json");
      assert.deepEqual(opts, { environment: "test", maxAgeMs: 1000 });
      return projectMonitorStatus(state(), { ...options, now: 20000 });
    },
  };
  for (const args of [
    [],
    ["private.json"],
    ["private.json", "test", "1e3"],
    ["private.json", "test", "01000"],
    ["private.json", "production", "999"],
    ["private.json", "test", "1000", "--watch"],
  ]) {
    assert.equal(await monitorStatusCommand(args, io), 2);
  }
  assert.equal(reads, 0);
  assert.equal(
    await monitorStatusCommand(["private.json", "test", "1000"], io),
    0,
  );
  assert.equal(JSON.parse(output[0]).heartbeat.status, "stale");
  assert.ok(errors.every((s) => s === "ARTFI_MONITOR_STATUS_REFUSED"));
  assert.equal(
    await monitorStatusCommand(["private.json", "test", "1000"], {
      ...io,
      read: async () => {
        throw Error("TEST_ONLY_PRIVATE_PATH");
      },
    }),
    2,
  );
  assert.ok(!errors.join("").includes("TEST_ONLY_PRIVATE_PATH"));
});
