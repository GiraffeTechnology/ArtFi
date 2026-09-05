import { readFile, access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Monitor } from "./monitor-core.mjs";

export function validateConfig(config) {
  if (
    !config ||
    config.schemaVersion !== 1 ||
    config.mode !== "monitor-only" ||
    config.inventoryVerified !== true ||
    config.enabled !== true ||
    ![
      "ctyun-abcdyi",
      "ctyun-aivan",
      "ctyun-mysql",
      "alibaba-singapore",
    ].includes(config.hostRole) ||
    !isAbsolute(config.stateDirectory ?? "") ||
    !isAbsolute(config.stopFile ?? "") ||
    !Number.isInteger(config.intervalMs) ||
    config.intervalMs < 1000 ||
    config.intervalMs > 300000 ||
    !Array.isArray(config.checks)
  )
    throw new Error("SERVICE_CONFIG_REFUSED");
  for (const check of config.checks) {
    const url = new URL(check.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !["liveness", "sanitized-metrics"].includes(check.kind)
    )
      throw new Error("PROBE_TARGET_REFUSED");
    if (
      check.kind === "liveness" &&
      !["web", "api", "link"].includes(check.category)
    )
      throw new Error("LIVENESS_IS_NOT_READINESS");
  }
  return config;
}

export function httpProbe(checks, fetchImpl = fetch, now = Date.now) {
  const configured = new Map(checks.map((check) => [check.id, check]));
  return async (id, signal) => {
    const check = configured.get(id);
    if (!check) throw new Error("UNKNOWN_PROBE");
    const response = await fetchImpl(check.url, {
      method: "GET",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { available: false, observedAt: now(), fresh: false };
    }
    if (check.kind === "liveness") {
      await response.body?.cancel();
      return { available: true, observedAt: now(), fresh: true };
    }
    // Private local telemetry must be purpose-built; no application response body is sent to Qwen.
    const reader = response.body.getReader();
    let body = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4096) throw new Error("METRIC_SIZE_REFUSED");
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
    }
    const sample = JSON.parse(body);
    if (
      Object.keys(sample).sort().join(",") !== "available,fresh,observedAt" ||
      typeof sample.available !== "boolean" ||
      typeof sample.fresh !== "boolean" ||
      !Number.isSafeInteger(sample.observedAt)
    )
      throw new Error("METRIC_SCHEMA_REFUSED");
    return sample;
  };
}

export async function runService(config, { signal, once = false } = {}) {
  validateConfig(config);
  const monitor = new Monitor({
    directory: config.stateDirectory,
    environment: config.environment,
    checks: config.checks,
    probe: httpProbe(config.checks),
    threshold: 2,
    maxQueueEntries: config.maxQueueEntries,
    deliveredRetentionMs: config.deliveredRetentionMs,
  });
  // No model or notification adapter is enabled before its managed identity/channel is verified.
  do {
    try {
      await access(config.stopFile);
      return "MANUAL_STOP_ACTIVE";
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("STOP_CONTROL_UNREADABLE");
    }
    if (signal?.aborted) return "SHUTDOWN";
    let state;
    try {
      state = await monitor.tick(signal);
    } catch (error) {
      if (signal?.aborted && error.message === "MONITOR_TICK_ABORTED")
        return "SHUTDOWN";
      throw error;
    }
    if (once)
      return state.collection.status === "capacity-blocked"
        ? "MONITOR_QUEUE_CAPACITY_BLOCKED"
        : "TICK_COMPLETE";
    try {
      await delay(config.intervalMs, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
  } while (!signal?.aborted);
  return "SHUTDOWN";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const control = new AbortController();
  process.once("SIGINT", () => control.abort());
  process.once("SIGTERM", () => control.abort());
  try {
    const config = JSON.parse(await readFile(process.argv[2], "utf8"));
    const result = await runService(config, {
      signal: control.signal,
      once: process.argv[3] === "--once",
    });
    console.log(result);
    if (result === "MONITOR_QUEUE_CAPACITY_BLOCKED") process.exitCode = 2;
  } catch {
    // Do not print network URLs, file locations, exceptions or response bodies.
    console.error("ARTFI_MONITOR_SERVICE_REFUSED");
    process.exitCode = 1;
  }
}
