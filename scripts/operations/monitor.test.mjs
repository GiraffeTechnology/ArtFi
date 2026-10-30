import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleMonitor, validateMonitor } from "./monitor.mjs";
const config = () => ({
  format: 1,
  executionZone: "sin",
  probes: [
    {
      name: "web",
      kind: "http",
      url: "http://127.0.0.1:3000/api/health",
      service: "artfi-web",
    },
    {
      name: "api",
      kind: "http",
      url: "http://127.0.0.1:8080/readyz",
      service: "artfi-api",
    },
    {
      name: "chain",
      kind: "chain",
      url: "https://rpc.example.test",
      chainId: 560048,
      maxAgeSeconds: 90,
    },
  ],
  diskPath: "/synthetic",
});
const fixture = {
  now: () => 2000000,
  host: () => ({
    freeMemoryBytes: 500,
    totalMemoryBytes: 1000,
    loadPerCPU: 0.1,
  }),
  disk: async () => ({ bavail: 50, bsize: 10, blocks: 100 }),
};
function reader({ old = false, id = "0x88bb0", down = false } = {}) {
  return async (url, options) => {
    if (url.includes("/api/health"))
      return Response.json({ service: "artfi-web" });
    if (url.includes("/readyz"))
      return Response.json(
        { service: "artfi-api" },
        { status: down ? 503 : 200 },
      );
    const q = JSON.parse(options.body);
    return Response.json({
      id: 1,
      result:
        q.method === "eth_chainId"
          ? id
          : { number: "0x2", timestamp: old ? "0x1" : "0x7d0" },
    });
  };
}
test("healthy application, database readiness, chain and host sample", async () => {
  const result = await sampleMonitor(config(), {
    ...fixture,
    fetcher: reader(),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.probes.length, 3);
});
test("stale chain and current API outage produce bounded operator alerts", async () => {
  const result = await sampleMonitor(config(), {
    ...fixture,
    fetcher: reader({ old: true, down: true }),
  });
  assert.deepEqual(result.alerts, [
    { name: "api", reason: "unavailable" },
    { name: "chain", reason: "stale" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /rpc.example|127.0.0.1/);
});
test("wrong chain is not reported as successful monitoring", async () => {
  const result = await sampleMonitor(config(), {
    ...fixture,
    fetcher: reader({ id: "0x1" }),
  });
  assert.equal(result.probes[2].status, "wrong_chain");
});
test("read-only monitor prevents public-chain egress from delivery zone and credential-bearing URLs", () => {
  const c = config();
  c.executionZone = "delivery";
  assert.throws(() => validateMonitor(c), /SIN/);
  for (const url of [
    "https://a:b@example.test",
    "https://example.test/?token=secret",
    "http://example.test",
  ]) {
    const d = config();
    d.probes[0].url = url;
    assert.throws(() => validateMonitor(d));
  }
});
test("host capacity thresholds and probe response limits are observable", async () => {
  const c = config();
  c.probes = c.probes.slice(0, 1);
  const result = await sampleMonitor(c, {
    ...fixture,
    host: () => ({ freeMemoryBytes: 1, totalMemoryBytes: 1000, loadPerCPU: 9 }),
    fetcher: async () => new Response("x".repeat(70000)),
    disk: async () => ({ bavail: 1, bsize: 10, blocks: 100 }),
  });
  assert.deepEqual(
    result.alerts.map((a) => a.name),
    ["web", "host-memory", "host-load", "host-disk"],
  );
});

test("invalid capacity thresholds do not silently disable alerts", () => {
  for (const [key, value] of [
    ["minimumFreeDiskRatio", 0],
    ["minimumFreeMemoryRatio", 1],
    ["maximumLoadPerCPU", -1],
    ["diskPath", "relative"],
  ]) {
    const c = config();
    c[key] = value;
    assert.throws(() => validateMonitor(c));
  }
});
