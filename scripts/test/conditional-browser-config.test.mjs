import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = join(root, "apps/web");
const bundle = "/TEST_ONLY_NOT_STARTED/verified-bundle";

// --list loads the actual config and specs, but never starts a server/browser.
function discover(file, external = false) {
  const env = {
    ...process.env,
    CI: "1",
    ARTFI_E2E_BUNDLE_ROOT: bundle,
    ARTFI_AGENT_REAL_BROWSER_FIXTURE: "1",
    NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS:
      "0x1000000000000000000000000000000000000001",
  };
  delete env.ARTFI_E2E_BASE_URL;
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;
  if (external) env.ARTFI_E2E_BASE_URL = "http://127.0.0.1:3000";
  const result = spawnSync(
    process.execPath,
    [
      join(web, "node_modules/@playwright/test/cli.js"),
      "test",
      `e2e/${file}`,
      "--config=playwright.fixtures.config.ts",
      "--list",
      "--reporter=json",
    ],
    { cwd: web, env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function originalProjects(report) {
  assert.deepEqual(
    report.config.projects.map(({ name, retries }) => ({ name, retries })),
    [
      { name: "desktop-chromium", retries: 0 },
      { name: "mobile-chromium", retries: 0 },
    ],
  );
}

test("charity owns exactly one loopback server and never reuses it", () => {
  const report = discover("charity-editions-populated.spec.ts");
  originalProjects(report);
  const server = report.config.webServer;
  assert.ok(
    server,
    "Expected one server; defineConfig concatenates multiple webServer entries",
  );
  assert.equal(Array.isArray(server), false);
  assert.equal(server.url, "http://127.0.0.1:3000/api/health");
  assert.equal(server.reuseExistingServer, false);
  assert.equal(server.env.HOSTNAME, "127.0.0.1");
  assert.equal(server.env.PORT, "3000");
  assert.ok(server.command.includes(`${bundle}/runtime/bin/node`));
  assert.ok(
    server.command.includes(`${bundle}/runtime/web/apps/web/server.js`),
  );
});

test("agent external-server mode does not start another server", () => {
  const report = discover("agent-runtime-live.spec.ts", true);
  originalProjects(report);
  assert.equal(report.config.webServer, null);
});
