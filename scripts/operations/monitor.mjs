#!/usr/bin/env node
/** Read-only M6 monitor. Output contains probe labels and summaries, never credentials or response bodies. */
import { readFile, statfs } from "node:fs/promises";
import { freemem, totalmem, loadavg, availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const loopback = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h);
const label = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
function target(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !loopback(url.hostname))
  )
    throw new Error(
      "Probe URLs require HTTPS or isolated loopback HTTP, without credentials, query or fragment.",
    );
  return url.toString();
}
export function validateMonitor(config) {
  if (
    !config ||
    config.format !== 1 ||
    !Array.isArray(config.probes) ||
    config.probes.length > 64
  )
    throw new Error("Expected a bounded format-1 monitor configuration.");
  for (const probe of config.probes) {
    if (!label(probe.name) || !["http", "chain"].includes(probe.kind))
      throw new Error("Invalid probe name/kind.");
    target(probe.url);
    if (probe.kind === "chain" && config.executionZone !== "sin")
      throw new Error(
        "Public-chain monitoring belongs to the configured SIN execution zone.",
      );
    if (probe.service !== undefined && !label(probe.service))
      throw new Error("Invalid expected service.");
    if (
      probe.kind === "chain" &&
      (!Number.isSafeInteger(probe.chainId) ||
        probe.chainId < 1 ||
        !Number.isFinite(probe.maxAgeSeconds) ||
        probe.maxAgeSeconds < 1)
    )
      throw new Error(
        "Chain probes require an expected chainId and maximum block age.",
      );
  }
  if (new Set(config.probes.map((p) => p.name)).size !== config.probes.length)
    throw new Error("Probe labels must be unique.");
  if (
    config.intervalSeconds !== undefined &&
    (!Number.isFinite(config.intervalSeconds) ||
      config.intervalSeconds < 5 ||
      config.intervalSeconds > 3600)
  )
    throw new Error("Monitor interval must be 5–3600 seconds.");
  for (const key of ["minimumFreeMemoryRatio", "minimumFreeDiskRatio"]) {
    if (
      config[key] !== undefined &&
      (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] >= 1)
    )
      throw new Error(`${key}: expected a fraction between zero and one.`);
  }
  if (
    config.maximumLoadPerCPU !== undefined &&
    (!Number.isFinite(config.maximumLoadPerCPU) ||
      config.maximumLoadPerCPU <= 0)
  )
    throw new Error("maximumLoadPerCPU must be positive.");
  if (
    config.diskPath !== undefined &&
    (typeof config.diskPath !== "string" ||
      !config.diskPath.startsWith("/") ||
      /[\x00-\x1f]/.test(config.diskPath))
  )
    throw new Error("diskPath must be an absolute filesystem path.");
  return config;
}
async function jsonResponse(response) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > 65536) throw new Error("oversized");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  let size = 0,
    chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error("oversized");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function rpc(url, method, params, fetcher) {
  const r = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3000),
    redirect: "error",
  });
  if (!r.ok) throw new Error("unavailable");
  const body = await jsonResponse(r);
  if (body.error || body.id !== 1) throw new Error("invalid");
  return body.result;
}
export async function sampleMonitor(
  config,
  {
    fetcher = fetch,
    now = () => Date.now(),
    host = () => ({
      freeMemoryBytes: freemem(),
      totalMemoryBytes: totalmem(),
      loadPerCPU: loadavg()[0] / availableParallelism(),
    }),
    disk = statfs,
  } = {},
) {
  validateMonitor(config);
  const observedAt = new Date(now()).toISOString();
  const results = await Promise.all(
    config.probes.map(async (probe) => {
      const started = now();
      try {
        const url = target(probe.url);
        if (probe.kind === "chain") {
          const id = await rpc(url, "eth_chainId", [], fetcher);
          if (
            !/^0x[0-9a-f]+$/i.test(id) ||
            BigInt(id) !== BigInt(probe.chainId)
          )
            return { name: probe.name, status: "wrong_chain" };
          const block = await rpc(
            url,
            "eth_getBlockByNumber",
            ["latest", false],
            fetcher,
          );
          if (
            !block ||
            !/^0x[0-9a-f]+$/i.test(block.timestamp) ||
            !/^0x[0-9a-f]+$/i.test(block.number)
          )
            throw new Error("invalid");
          const ageSeconds =
            Math.floor(now() / 1000) - Number(BigInt(block.timestamp));
          if (!Number.isSafeInteger(ageSeconds) || ageSeconds < -30)
            return { name: probe.name, status: "invalid_timestamp" };
          return {
            name: probe.name,
            status: ageSeconds > probe.maxAgeSeconds ? "stale" : "ok",
            blockNumber: BigInt(block.number).toString(),
            ageSeconds,
          };
        }
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        });
        if (!response.ok)
          return {
            name: probe.name,
            status: "unavailable",
            httpStatus: response.status,
          };
        const body = await jsonResponse(response);
        return {
          name: probe.name,
          status:
            probe.service && body.service !== probe.service
              ? "wrong_service"
              : "ok",
          durationMs: Math.max(0, now() - started),
        };
      } catch {
        return { name: probe.name, status: "unavailable" };
      }
    }),
  );
  const measurements = host();
  const alerts = results
    .filter((p) => p.status !== "ok")
    .map((p) => ({ name: p.name, reason: p.status }));
  if (
    measurements.freeMemoryBytes / measurements.totalMemoryBytes <
    (config.minimumFreeMemoryRatio ?? 0.05)
  )
    alerts.push({ name: "host-memory", reason: "low_capacity" });
  if (measurements.loadPerCPU > (config.maximumLoadPerCPU ?? 2))
    alerts.push({ name: "host-load", reason: "high_load" });
  let diskCapacity;
  if (config.diskPath) {
    try {
      const fs = await disk(config.diskPath);
      diskCapacity = {
        availableBytes: fs.bavail * fs.bsize,
        totalBytes: fs.blocks * fs.bsize,
      };
      if (
        diskCapacity.availableBytes / diskCapacity.totalBytes <
        (config.minimumFreeDiskRatio ?? 0.1)
      )
        alerts.push({ name: "host-disk", reason: "low_capacity" });
    } catch {
      alerts.push({ name: "host-disk", reason: "unavailable" });
    }
  }
  return {
    format: 1,
    type: "artfi-monitor",
    observedAt,
    status: alerts.length ? "alert" : "ok",
    probes: results,
    host: measurements,
    ...(diskCapacity ? { disk: diskCapacity } : {}),
    alerts,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [file, mode = "--once", ...rest] = process.argv.slice(2);
    if (!file || !["--once", "--watch"].includes(mode) || rest.length)
      throw new Error("Usage: node monitor.mjs CONFIG.json [--once|--watch]");
    const config = validateMonitor(JSON.parse(await readFile(file, "utf8")));
    let stopped = false;
    let wake;
    const stop = () => {
      stopped = true;
      wake?.();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    do {
      const result = await sampleMonitor(config);
      console.log(JSON.stringify(result));
      if (mode === "--once") {
        process.exitCode = result.status === "ok" ? 0 : 1;
        break;
      }
      if (!stopped)
        await new Promise((resolve) => {
          const timer = setTimeout(
            resolve,
            (config.intervalSeconds ?? 30) * 1000,
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      wake = undefined;
    } while (!stopped);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
