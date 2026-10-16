import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maxBytes = 8 * 1024 * 1024;
const label = /^[a-z][a-z0-9-]{0,47}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const categories = new Set([
  "web",
  "api",
  "mirror",
  "db",
  "link",
  "capacity",
  "backup",
]);
const statuses = new Set(["healthy", "unavailable", "stale", "unknown"]);
const recommendations = new Set([
  "inspect-service",
  "inspect-provider",
  "inspect-capacity",
  "human-review",
]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const refuse = () => {
  throw new Error("MONITOR_STATUS_REFUSED");
};

function optionsValid({ environment, maxAgeMs, now }) {
  if (
    !["test", "production"].includes(environment) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1000 ||
    maxAgeMs > 86400000 ||
    !timestamp(now)
  )
    refuse();
}

function capacityGap(value) {
  if (
    !record(value) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.endedAt) ||
    value.endedAt < value.startedAt
  )
    refuse();
  return { startedAt: value.startedAt, endedAt: value.endedAt };
}

// This projection reports persisted observations, never current service readiness.
export function projectMonitorStatus(
  saved,
  { environment, maxAgeMs, now = Date.now() } = {},
) {
  optionsValid({ environment, maxAgeMs, now });
  if (
    !record(saved) ||
    saved.version !== 1 ||
    saved.environment !== environment ||
    !record(saved.checks) ||
    !Array.isArray(saved.queue) ||
    Object.keys(saved.checks).length > 10000 ||
    saved.queue.length > 10000
  )
    refuse();
  const checks = Object.entries(saved.checks)
    .map(([id, check]) => {
      if (
        !label.test(id) ||
        !record(check) ||
        !statuses.has(check.status) ||
        !Number.isInteger(check.consecutive) ||
        check.consecutive < 0 ||
        check.consecutive > 10 ||
        !(check.incident === null || uuid.test(check.incident)) ||
        (check.category !== undefined && !categories.has(check.category))
      )
        refuse();
      return {
        id,
        category: check.category ?? null,
        status: check.status,
        consecutive: check.consecutive,
        incidentId: check.incident,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set();
  const delivery = { pending: 0, delivered: 0, "needs-human": 0 };
  const events = saved.queue
    .map((event) => {
      if (
        !record(event) ||
        !uuid.test(event.id) ||
        ids.has(event.id) ||
        !label.test(event.checkId) ||
        !categories.has(event.category) ||
        event.environment !== environment ||
        !["incident", "recovery"].includes(event.type) ||
        !statuses.has(event.status) ||
        !timestamp(event.observedAt) ||
        !recommendations.has(event.recommendation) ||
        !Object.hasOwn(delivery, event.delivery) ||
        !Number.isSafeInteger(event.attempts) ||
        event.attempts < 0 ||
        (event.type === "incident" && event.status === "healthy") ||
        (event.type === "recovery" &&
          (event.status !== "healthy" || !uuid.test(event.incidentId))) ||
        (event.delivery === "delivered"
          ? !timestamp(event.deliveredAt)
          : event.deliveredAt !== undefined)
      )
        refuse();
      ids.add(event.id);
      delivery[event.delivery]++;
      return {
        id: event.id,
        checkId: event.checkId,
        category: event.category,
        type: event.type,
        status: event.status,
        observedAt: event.observedAt,
        recommendation: event.recommendation,
        delivery: event.delivery,
        attempts: event.attempts,
        ...(event.type === "recovery" ? { incidentId: event.incidentId } : {}),
        ...(event.delivery === "delivered"
          ? { deliveredAt: event.deliveredAt }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        b.observedAt - a.observedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  let collection = { status: "unknown" };
  if (saved.collection !== undefined) {
    const value = saved.collection;
    if (
      !record(value) ||
      !["complete", "capacity-blocked"].includes(value.status)
    )
      refuse();
    collection = { status: value.status };
    if (value.status === "capacity-blocked") {
      if (
        value.code !== "MONITOR_QUEUE_CAPACITY_BLOCKED" ||
        !timestamp(value.blockedSince) ||
        !timestamp(value.lastAttemptAt) ||
        value.lastAttemptAt < value.blockedSince
      )
        refuse();
      Object.assign(collection, {
        code: value.code,
        blockedSince: value.blockedSince,
        lastAttemptAt: value.lastAttemptAt,
      });
    }
    if (value.lastCapacityGap !== undefined)
      collection.lastCapacityGap = capacityGap(value.lastCapacityGap);
  }
  let retention = { expiredDelivered: 0, capacityEvictedDelivered: 0 };
  if (saved.retention !== undefined) {
    if (
      !record(saved.retention) ||
      !timestamp(saved.retention.expiredDelivered) ||
      !timestamp(saved.retention.capacityEvictedDelivered)
    )
      refuse();
    retention = {
      expiredDelivered: saved.retention.expiredDelivered,
      capacityEvictedDelivered: saved.retention.capacityEvictedDelivered,
    };
  }
  if (saved.heartbeatAt !== undefined && !timestamp(saved.heartbeatAt))
    refuse();
  const ageMs =
    saved.heartbeatAt === undefined || saved.heartbeatAt > now
      ? null
      : now - saved.heartbeatAt;
  return {
    version: 1,
    type: "artfi-monitor-status",
    environment,
    readAt: now,
    heartbeat: {
      status: ageMs === null ? "unknown" : ageMs > maxAgeMs ? "stale" : "fresh",
      at: saved.heartbeatAt ?? null,
      ageMs,
      maxAgeMs,
    },
    collection,
    checks,
    checksWithIncidentCount: checks.filter((check) => check.incidentId !== null)
      .length,
    delivery,
    retention,
    retainedEventCount: events.length,
    eventsOmitted: Math.max(0, events.length - 100),
    events: events.slice(0, 100),
  };
}

// An open descriptor observes one committed inode across the writer's atomic rename.
// No monitor engine, configuration, network adapter, lock or write is involved.
export async function readMonitorStatus(path, options) {
  let file;
  try {
    if (typeof path !== "string" || !path || path.includes("\0")) refuse();
    const now = options?.now ?? Date.now();
    optionsValid({ ...options, now });
    file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) refuse();
    const chunks = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maxBytes) refuse();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const raw = Buffer.concat(chunks, length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return {
      ...projectMonitorStatus(JSON.parse(text), { ...options, now }),
      source: {
        bytes: length,
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
    };
  } catch {
    // Neither paths, raw file bytes nor parse/OS exceptions leave the reader.
    refuse();
  } finally {
    try {
      await file?.close();
    } catch {
      refuse();
    }
  }
}

export async function monitorStatusCommand(
  args,
  { read = readMonitorStatus, out = console.log, error = console.error } = {},
) {
  try {
    const [path, environment, age, ...rest] = args;
    if (!path || rest.length || !/^[1-9][0-9]*$/.test(age ?? "")) refuse();
    const maxAgeMs = Number(age);
    optionsValid({ environment, maxAgeMs, now: Date.now() });
    out(JSON.stringify(await read(path, { environment, maxAgeMs })));
    return 0; // Successful inspection, including stale/unknown/needs-human results.
  } catch {
    error("ARTFI_MONITOR_STATUS_REFUSED");
    return 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await monitorStatusCommand(process.argv.slice(2));
