import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateConfig, httpProbe, runService } from "./monitor-service.mjs";

function config(directory) {
  return {
    schemaVersion: 1,
    enabled: true,
    inventoryVerified: true,
    hostRole: "ctyun-abcdyi",
    mode: "monitor-only",
    environment: "test",
    stateDirectory: directory,
    stopFile: join(directory, "STOP"),
    intervalMs: 1000,
    checks: [
      {
        id: "test-api",
        category: "api",
        kind: "liveness",
        url: "http://127.0.0.1:12345/healthz",
        maxAgeMs: 10000,
      },
    ],
  };
}
test("external, credential-bearing, unverified and fake DB liveness targets are rejected", () => {
  for (const url of [
    "https://example.com",
    "http://localhost/",
    "http://u:p@127.0.0.1/",
    "http://127.0.0.1/?token=x",
  ]) {
    const c = config(tmpdir());
    c.checks[0].url = url;
    assert.throws(() => validateConfig(c));
  }
  assert.throws(() =>
    validateConfig({ ...config(tmpdir()), inventoryVerified: false }),
  );
  const c = config(tmpdir());
  c.checks[0].category = "db";
  assert.throws(() => validateConfig(c), /READINESS/);
});
test("raw payload/oversize metrics are refused", async () => {
  const check = {
    id: "mirror",
    kind: "sanitized-metrics",
    url: "http://127.0.0.1/",
  };
  for (const body of [
    JSON.stringify({ secret: "never send" }),
    "x".repeat(4097),
  ]) {
    await assert.rejects(
      httpProbe([check], async () => new Response(body))("mirror"),
    );
  }
});
test("actual loopback service outage produces persistent incident, then recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "artfi-service-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failing = true;
  const server = createServer((_, res) => {
    res.writeHead(failing ? 503 : 200);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const c = config(directory);
  c.checks[0].url = `http://127.0.0.1:${server.address().port}/healthz`;
  await runService(c, { once: true });
  await runService(c, { once: true });
  let saved = JSON.parse(
    await readFile(join(directory, "monitor-state.json"), "utf8"),
  );
  assert.equal(saved.queue.length, 1);
  assert.equal(saved.queue[0].status, "unavailable");
  failing = false;
  await runService(c, { once: true });
  saved = JSON.parse(
    await readFile(join(directory, "monitor-state.json"), "utf8"),
  );
  assert.equal(saved.queue[1].type, "recovery");
  await writeFile(c.stopFile, "operator stop");
  assert.equal(await runService(c, { once: true }), "MANUAL_STOP_ACTIVE");
});

test("once mode reports queue capacity refusal rather than tick complete", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "artfi-service-capacity-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((_, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const c = config(directory);
  c.maxQueueEntries = 1;
  c.checks[0].url = `http://127.0.0.1:${server.address().port}/healthz`;
  c.checks.push({ ...c.checks[0], id: "test-web", category: "web" });
  assert.equal(await runService(c, { once: true }), "TICK_COMPLETE");
  assert.equal(
    await runService(c, { once: true }),
    "MONITOR_QUEUE_CAPACITY_BLOCKED",
  );
  const configFile = join(directory, "test-config.json");
  await writeFile(configFile, JSON.stringify(c));
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./monitor-service.mjs", import.meta.url)),
        configFile,
        "--once",
      ],
      { timeout: 5000, windowsHide: true },
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout.trim(), "MONITOR_QUEUE_CAPACITY_BLOCKED");
      assert.equal(error.stderr, "");
      return true;
    },
  );
});
