import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const categories = new Set([
  "web",
  "api",
  "mirror",
  "db",
  "link",
  "capacity",
  "backup",
]);
const advice = new Set([
  "inspect-service",
  "inspect-provider",
  "inspect-capacity",
  "human-review",
]);
const states = new Set(["healthy", "unavailable", "stale", "unknown"]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function notificationRecord(event, environment) {
  // Durable event identity is independent of today's active probe inventory.
  if (
    !event ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(event.checkId) ||
    !categories.has(event.category) ||
    event.environment !== environment ||
    !uuid.test(event.id) ||
    !states.has(event.status) ||
    !["incident", "recovery"].includes(event.type) ||
    (event.type === "recovery" && event.status !== "healthy") ||
    (event.type === "incident" && event.status === "healthy") ||
    !Number.isSafeInteger(event.observedAt) ||
    event.observedAt < 0 ||
    !advice.has(event.recommendation) ||
    (event.type === "recovery" && !uuid.test(event.incidentId))
  )
    throw new Error("QUEUE_RECORD_REFUSED");
  // Never forward arbitrary disk fields, including future diagnostic additions.
  return {
    id: event.id,
    checkId: event.checkId,
    category: event.category,
    environment,
    type: event.type,
    status: event.status,
    observedAt: event.observedAt,
    recommendation: event.recommendation,
    ...(event.type === "recovery" ? { incidentId: event.incidentId } : {}),
  };
}

function expireDelivered(saved, now, retentionMs) {
  saved.retention ??= { expiredDelivered: 0, capacityEvictedDelivered: 0 };
  if (
    !Number.isSafeInteger(saved.retention.expiredDelivered) ||
    saved.retention.expiredDelivered < 0 ||
    !Number.isSafeInteger(saved.retention.capacityEvictedDelivered) ||
    saved.retention.capacityEvictedDelivered < 0
  )
    throw new Error("RETENTION_STATE_REFUSED");
  const before = saved.queue.length;
  saved.queue = saved.queue.filter(
    (event) =>
      !(
        event.delivery === "delivered" &&
        Number.isSafeInteger(event.deliveredAt) &&
        event.deliveredAt <= now - retentionMs
      ),
  );
  saved.retention.expiredDelivered = Math.min(
    Number.MAX_SAFE_INTEGER,
    saved.retention.expiredDelivered + before - saved.queue.length,
  );
}

function enqueue(saved, event, maxEntries) {
  if (saved.queue.length >= maxEntries) {
    // Age retention is a maximum, not a promise to keep acknowledged records
    // when undelivered incidents need the bounded space.
    const delivered = saved.queue.findIndex(
      (item) => item.delivery === "delivered",
    );
    if (delivered < 0) return false;
    saved.queue.splice(delivered, 1);
    saved.retention.capacityEvictedDelivered = Math.min(
      Number.MAX_SAFE_INTEGER,
      saved.retention.capacityEvictedDelivered + 1,
    );
  }
  saved.queue.push(event);
  return true;
}

export function evaluate(sample, now, maxAgeMs) {
  if (
    !sample ||
    !Number.isSafeInteger(sample.observedAt) ||
    sample.observedAt > now ||
    now - sample.observedAt > maxAgeMs
  )
    return "unknown";
  if (sample.available !== true) return "unavailable";
  // A 200 or provider event timestamp alone is never a freshness heartbeat.
  if (sample.fresh !== true) return "stale";
  return "healthy";
}

export async function atomicJson(path, value) {
  // Serialize before creating anything; invalid state must leave committed bytes intact.
  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error();
  } catch {
    throw new Error("MONITOR_STATE_SERIALIZATION_REFUSED");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  let ownedTemp = false;
  try {
    file = await open(temp, "wx", 0o600);
    ownedTemp = true;
    await file.writeFile(serialized);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temp, path);
    ownedTemp = false;
  } catch {
    throw new Error("MONITOR_STATE_WRITE_REFUSED");
  } finally {
    try {
      if (file) await file.close();
    } finally {
      // Never sweep a directory or remove a file whose exclusive create failed.
      if (ownedTemp) {
        try {
          await unlink(temp);
        } catch {
          throw new Error("MONITOR_STATE_TEMP_CLEANUP_REFUSED");
        }
      }
    }
  }
}

function refuseAborted(signal) {
  if (signal?.aborted) throw new Error("MONITOR_TICK_ABORTED");
}

export async function bounded(call, milliseconds, signal) {
  let timer;
  let abort;
  const controller = new AbortController();
  try {
    refuseAborted(signal);
    return await Promise.race([
      Promise.resolve().then(() => {
        refuseAborted(signal);
        return call(controller.signal);
      }),
      new Promise((_, reject) => {
        abort = () => {
          controller.abort();
          reject(new Error("MONITOR_TICK_ABORTED"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("DEPENDENCY_TIMEOUT"));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export class Monitor {
  constructor({
    directory,
    environment,
    checks,
    probe,
    classify,
    notify,
    now = Date.now,
    timeoutMs = 5000,
    threshold = 2,
    maxDeliveryAttempts = 3,
    deliveredRetentionMs = 7 * 24 * 60 * 60 * 1000,
    maxQueueEntries = 4096,
  }) {
    if (
      !["test", "production"].includes(environment) ||
      !Array.isArray(checks) ||
      checks.length < 1 ||
      checks.length > 64 ||
      timeoutMs < 1 ||
      timeoutMs > 30000 ||
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > 10 ||
      !Number.isInteger(maxDeliveryAttempts) ||
      maxDeliveryAttempts < 1 ||
      maxDeliveryAttempts > 10 ||
      !Number.isSafeInteger(deliveredRetentionMs) ||
      deliveredRetentionMs < 1000 ||
      deliveredRetentionMs > 90 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(maxQueueEntries) ||
      maxQueueEntries < 1 ||
      maxQueueEntries > 10000
    )
      throw new Error("MONITOR_CONFIG_REFUSED");
    const ids = new Set();
    for (const check of checks) {
      if (
        !/^[a-z][a-z0-9-]{0,47}$/.test(check.id) ||
        ids.has(check.id) ||
        !categories.has(check.category) ||
        !Number.isSafeInteger(check.maxAgeMs) ||
        check.maxAgeMs < 1000 ||
        check.maxAgeMs > 86400000
      )
        throw new Error("CHECK_CONFIG_REFUSED");
      ids.add(check.id);
    }
    Object.assign(this, {
      directory,
      environment,
      checks,
      probe,
      classify,
      notify,
      now,
      timeoutMs,
      threshold,
      maxDeliveryAttempts,
      deliveredRetentionMs,
      maxQueueEntries,
    });
    this.running = false;
  }

  async tick(signal) {
    if (this.running) throw new Error("OVERLAPPING_TICK_REFUSED");
    this.running = true;
    try {
      refuseAborted(signal);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "monitor-state.json");
      let saved;
      try {
        saved = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("MONITOR_STATE_UNREADABLE");
        saved = {
          version: 1,
          environment: this.environment,
          checks: {},
          queue: [],
        };
      }
      if (
        !saved ||
        saved.version !== 1 ||
        saved.environment !== this.environment ||
        !saved.checks ||
        typeof saved.checks !== "object" ||
        Array.isArray(saved.checks) ||
        !Array.isArray(saved.queue)
      )
        throw new Error("MONITOR_STATE_IDENTITY_REFUSED");
      for (const prior of Object.values(saved.checks)) {
        if (
          !prior ||
          typeof prior !== "object" ||
          !Number.isInteger(prior.consecutive) ||
          prior.consecutive < 0 ||
          prior.consecutive > 10 ||
          !(prior.incident === null || uuid.test(prior.incident)) ||
          !states.has(prior.status)
        )
          throw new Error("MONITOR_CHECK_STATE_REFUSED");
      }
      const observedAt = this.now();
      // Validate before retention can discard anything, and before any adapter.
      for (const event of saved.queue) {
        notificationRecord(event, this.environment);
        if (
          !["pending", "delivered", "needs-human"].includes(event.delivery) ||
          !Number.isSafeInteger(event.attempts) ||
          event.attempts < 0 ||
          (event.delivery === "delivered"
            ? !Number.isSafeInteger(event.deliveredAt) || event.deliveredAt < 0
            : event.deliveredAt !== undefined)
        )
          throw new Error("QUEUE_RECORD_REFUSED");
      }
      expireDelivered(saved, observedAt, this.deliveredRetentionMs);
      if (saved.queue.length > this.maxQueueEntries)
        throw new Error("QUEUE_STATE_EXCEEDS_CONFIGURED_LIMIT");
      const durable = structuredClone(saved);
      let capacityBlocked = false;
      for (const check of this.checks) {
        refuseAborted(signal);
        let sample;
        try {
          sample = await bounded(
            (signal) => this.probe(check.id, signal),
            this.timeoutMs,
            signal,
          );
        } catch {
          refuseAborted(signal);
          sample = null;
        }
        refuseAborted(signal);
        const status = evaluate(sample, this.now(), check.maxAgeMs);
        const prior = Object.hasOwn(saved.checks, check.id)
          ? saved.checks[check.id]
          : { consecutive: 0, incident: null };
        prior.consecutive =
          status === "healthy"
            ? 0
            : Math.min(this.threshold, prior.consecutive + 1);
        if (
          status !== "healthy" &&
          prior.consecutive >= this.threshold &&
          !prior.incident
        ) {
          prior.incident = randomUUID();
          if (
            !enqueue(
              saved,
              {
                id: prior.incident,
                checkId: check.id,
                category: check.category,
                environment: this.environment,
                type: "incident",
                status,
                observedAt,
                attempts: 0,
                delivery: "pending",
                model: "not-run",
                recommendation: "human-review",
              },
              this.maxQueueEntries,
            )
          ) {
            capacityBlocked = true;
            break;
          }
        } else if (status === "healthy" && prior.incident) {
          if (
            !enqueue(
              saved,
              {
                id: randomUUID(),
                incidentId: prior.incident,
                checkId: check.id,
                category: check.category,
                environment: this.environment,
                type: "recovery",
                status,
                observedAt,
                attempts: 0,
                delivery: "pending",
                model: "not-required",
                recommendation: "human-review",
              },
              this.maxQueueEntries,
            )
          ) {
            capacityBlocked = true;
            break;
          }
          prior.incident = null;
        }
        prior.status = status;
        saved.checks[check.id] = prior;
      }
      if (capacityBlocked) {
        // Do not commit a partial observation batch or pretend its incidents were
        // recorded. Preserve prior incident identities and keep draining delivery.
        saved = durable;
        saved.collection = {
          status: "capacity-blocked",
          code: "MONITOR_QUEUE_CAPACITY_BLOCKED",
          blockedSince: durable.collection?.blockedSince ?? observedAt,
          lastAttemptAt: observedAt,
          ...(durable.collection?.lastCapacityGap
            ? { lastCapacityGap: durable.collection.lastCapacityGap }
            : {}),
        };
      } else {
        saved.collection = {
          status: "complete",
          ...(durable.collection?.blockedSince !== undefined
            ? {
                lastCapacityGap: {
                  startedAt: durable.collection.blockedSince,
                  endedAt: observedAt,
                },
              }
            : durable.collection?.lastCapacityGap
              ? { lastCapacityGap: durable.collection.lastCapacityGap }
              : {}),
        };
      }
      // Persist incidents BEFORE contacting either optional dependency.
      refuseAborted(signal);
      await atomicJson(path, saved);
      for (const event of saved.queue) {
        refuseAborted(signal);
        notificationRecord(event, this.environment);
        if (event.model === "not-run") {
          event.model = "unavailable";
          if (this.classify)
            try {
              // No URL, raw body, log, error, wallet, credential or endpoint enters the model.
              const result = await bounded(
                (signal) =>
                  this.classify(
                    {
                      category: event.category,
                      status: event.status,
                      type: event.type,
                    },
                    signal,
                  ),
                this.timeoutMs,
                signal,
              );
              if (advice.has(result?.recommendation)) {
                event.model = "classified";
                event.recommendation = result.recommendation;
              }
            } catch {
              refuseAborted(signal);
              /* Deterministic monitoring and escalation remain available. */
            }
          await atomicJson(path, saved);
        }
        if (event.delivery !== "pending" || !this.notify) continue;
        if (event.attempts >= this.maxDeliveryAttempts) {
          event.delivery = "needs-human";
          continue;
        }
        // Delivery is at-least-once with a stable id for receiver-side deduplication.
        event.attempts += 1;
        await atomicJson(path, saved);
        try {
          const payload = notificationRecord(event, this.environment);
          const ack = await bounded(
            (signal) => this.notify(payload, signal),
            this.timeoutMs,
            signal,
          );
          refuseAborted(signal);
          if (ack?.id === event.id && ack.accepted === true) {
            event.delivery = "delivered";
            event.deliveredAt = this.now();
          }
        } catch {
          refuseAborted(signal);
          /* Never retain a potentially sensitive transport exception. */
        }
        if (
          event.delivery !== "delivered" &&
          event.attempts >= this.maxDeliveryAttempts
        )
          event.delivery = "needs-human";
        await atomicJson(path, saved);
      }
      refuseAborted(signal);
      // Observation persistence is not a completed tick. Keep the previous
      // heartbeat through uncertain delivery, shutdown, and capacity gaps.
      if (!capacityBlocked) saved.heartbeatAt = observedAt;
      await atomicJson(path, saved);
      return saved;
    } finally {
      this.running = false;
    }
  }
}
