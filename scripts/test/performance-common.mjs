import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function requestBudget({
  limit,
  durationMs = 0,
  now = () => performance.now(),
}) {
  assert.ok(Number.isSafeInteger(limit) && limit > 0);
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
  const start = now();
  let issued = 0,
    stopReason = null;
  return {
    take() {
      if (stopReason) return false;
      if (issued >= limit) {
        stopReason = "request-cap";
        return false;
      }
      if (durationMs && now() - start >= durationMs) {
        stopReason = "duration";
        return false;
      }
      issued++;
      return true;
    },
    get issued() {
      return issued;
    },
    get stopReason() {
      return stopReason;
    },
  };
}
export function summary(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  const round = (n) => (n === null ? null : Math.round(n * 1000) / 1000);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? null),
    meanMs: round(
      sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    ),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    p99Ms: round(percentile(0.99)),
    maxMs: round(sorted.at(-1) ?? null),
  };
}
export function loopbackURL(value) {
  const url = new URL(value);
  assert.equal(
    url.protocol,
    "http:",
    "Only isolated HTTP loopback targets are allowed.",
  );
  assert.equal(
    url.hostname,
    "127.0.0.1",
    "Refusing non-loopback performance target.",
  );
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  return url;
}
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function mapLimited(items, concurrency, fn) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}
export async function stop(process) {
  if (process.exitCode !== null || process.signalCode || !process.pid) return;
  const exited = once(process, "exit");
  process.kill("SIGTERM");
  const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
export async function waitFor(probe, label) {
  let last;
  for (let i = 0; i < 150; i++) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not become ready${last?.code ? ` (${last.code})` : ""}.`,
  );
}
