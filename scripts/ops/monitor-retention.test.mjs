import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Monitor } from "./monitor-core.mjs";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-retention-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { time: 10000, healthy: false };
  const config = {
    directory,
    environment: "test",
    threshold: 1,
    timeoutMs: 100,
    checks: [{ id: "test-api", category: "api", maxAgeMs: 1000 }],
    now: () => clock.time,
    probe: async () => ({
      observedAt: clock.time,
      available: clock.healthy,
      fresh: clock.healthy,
    }),
    deliveredRetentionMs: 1000,
    maxQueueEntries: 2,
    ...overrides,
  };
  return {
    clock,
    config,
    read: async () =>
      JSON.parse(await readFile(join(directory, "monitor-state.json"), "utf8")),
  };
}

test("retention expires acknowledged records without re-alerting an active incident", async (t) => {
  const { config, clock } = await fixture(t, {
    notify: async (e) => ({ id: e.id, accepted: true }),
  });
  const first = await new Monitor(config).tick();
  const incident = first.checks["test-api"].incident;
  assert.equal(first.queue[0].deliveredAt, clock.time);
  clock.time += 999;
  assert.equal((await new Monitor(config).tick()).queue.length, 1);
  clock.time += 1;
  const expired = await new Monitor(config).tick();
  assert.equal(expired.queue.length, 0);
  assert.equal(expired.checks["test-api"].incident, incident);
  assert.equal(expired.retention.expiredDelivered, 1);
  clock.healthy = true;
  const recovered = await new Monitor(config).tick();
  assert.equal(recovered.queue[0].type, "recovery");
  assert.equal(recovered.queue[0].incidentId, incident);
});

test("retention age never discards pending or exhausted delivery records", async (t) => {
  const { config, clock } = await fixture(t);
  const pending = await new Monitor(config).tick();
  clock.time += 100000;
  const later = await new Monitor(config).tick();
  assert.equal(later.queue[0].id, pending.queue[0].id);
  assert.equal(later.queue[0].delivery, "pending");
  config.notify = async () => {
    throw Error("TEST_ONLY_TRANSPORT_FAILURE");
  };
  config.maxDeliveryAttempts = 1;
  const exhausted = await new Monitor(config).tick();
  clock.time += 100000;
  const retained = await new Monitor(config).tick();
  assert.equal(retained.queue[0].delivery, "needs-human");
  assert.equal(retained.queue[0].id, exhausted.queue[0].id);
});

test("full pending queue persists an explicit collection gap and drains without silent eviction", async (t) => {
  const { config, clock, read } = await fixture(t);
  await new Monitor(config).tick();
  clock.healthy = true;
  clock.time += 1;
  const full = await new Monitor(config).tick();
  const ids = full.queue.map((e) => e.id);
  const priorHeartbeat = full.heartbeatAt;
  clock.healthy = false;
  clock.time += 1;
  const blocked = await new Monitor(config).tick();
  assert.equal(blocked.collection.status, "capacity-blocked");
  assert.equal(blocked.collection.code, "MONITOR_QUEUE_CAPACITY_BLOCKED");
  assert.equal(blocked.heartbeatAt, priorHeartbeat);
  assert.deepEqual(
    blocked.queue.map((e) => e.id),
    ids,
  );
  assert.equal(blocked.checks["test-api"].incident, null);
  assert.equal((await read()).collection.status, "capacity-blocked");
  const delivered = [];
  config.notify = async (event) => {
    delivered.push(event.id);
    return { id: event.id, accepted: true };
  };
  const drained = await new Monitor(config).tick();
  assert.deepEqual(delivered, ids);
  assert.equal(drained.collection.status, "capacity-blocked");
  clock.time += 1;
  const resumed = await new Monitor(config).tick();
  assert.equal(resumed.collection.status, "complete");
  assert.equal(
    resumed.collection.lastCapacityGap.startedAt,
    blocked.collection.blockedSince,
  );
  assert.equal(resumed.collection.lastCapacityGap.endedAt, clock.time);
  assert.equal(resumed.retention.capacityEvictedDelivered, 1);
  assert.equal(resumed.queue.length, 2);
  assert.equal(resumed.queue[1].type, "incident");
  assert.ok(!ids.includes(resumed.queue[1].id));
});

test("queue and retention configuration have finite validated bounds", async (t) => {
  const { config } = await fixture(t);
  for (const value of [0, -1, 10001, 1.1, Infinity, "2"]) {
    assert.throws(
      () => new Monitor({ ...config, maxQueueEntries: value }),
      /CONFIG_REFUSED/,
    );
  }
  for (const value of [0, -1, 999, Infinity, "1000", 7776000001]) {
    assert.throws(
      () => new Monitor({ ...config, deliveredRetentionMs: value }),
      /CONFIG_REFUSED/,
    );
  }
});

test("capacity refuses a partial multi-check observation batch", async (t) => {
  const { config, read } = await fixture(t, {
    maxQueueEntries: 1,
    checks: [
      { id: "test-api", category: "api", maxAgeMs: 1000 },
      { id: "test-web", category: "web", maxAgeMs: 1000 },
    ],
  });
  const blocked = await new Monitor(config).tick();
  assert.equal(blocked.collection.status, "capacity-blocked");
  assert.equal(blocked.queue.length, 0);
  assert.deepEqual(blocked.checks, {});
  assert.equal(blocked.heartbeatAt, undefined);
  assert.equal((await read()).queue.length, 0);
});

test("lowering the queue limit never rewrites an oversized pending queue", async (t) => {
  const { config, clock, read } = await fixture(t);
  await new Monitor(config).tick();
  clock.healthy = true;
  const full = await new Monitor(config).tick();
  await assert.rejects(
    new Monitor({ ...config, maxQueueEntries: 1 }).tick(),
    /QUEUE_STATE_EXCEEDS_CONFIGURED_LIMIT/,
  );
  assert.deepEqual(await read(), full);
});
