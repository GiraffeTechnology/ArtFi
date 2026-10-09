// Runs current or precompiled package code against a fresh harness-owned DB.
// Only wallet/venue/chain payloads are synthetic; session/BFF/runtime/SQL are real.
import { spawn } from "node:child_process";
import { readFile, writeFile, open } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configFile = process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG;
if (!configFile) throw Error("ISOLATED_MYSQL_HARNESS_REQUIRED");
const data = dirname(configFile),
  database = JSON.parse(await readFile(configFile, "utf8"));
if (
  database.database !== "artfi_stage2_isolated_test" ||
  database.host !== "127.0.0.1"
)
  throw Error("ISOLATED_MYSQL_REQUIRED");
const bundle = process.env.ARTFI_AGENT_TEST_BUNDLE
  ? resolve(process.env.ARTFI_AGENT_TEST_BUNDLE)
  : null;
const node = bundle ? join(bundle, "runtime/bin/node") : process.execPath;
const api = bundle
  ? join(bundle, "runtime/bin/artfi-api")
  : join(data, "artfi-api");
const password = (await readFile(database.passwordFile, "utf8")).trim();
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  HOSTNAME: "127.0.0.1",
  PORT: "3000",
  ARTFI_API_ADDR: "127.0.0.1:8080",
  ARTFI_API_URL: "http://127.0.0.1:8080",
  ARTFI_WEB_URL: "http://127.0.0.1:3000",
  ARTFI_WEB_ORIGIN: "http://127.0.0.1:3000",
  ARTFI_USER_AUTH_CHAIN_IDS: "560048",
  ARTFI_USER_AUTH_BRIDGE_TOKEN: "TEST_ONLY_REAL_SESSION_BRIDGE_CREDENTIAL",
  ARTFI_USER_SESSION_SECRET: "TEST_ONLY_REAL_SESSION_JWT_SIGNING_CREDENTIAL",
  ARTFI_AGENT_BRIDGE_TOKEN: "TEST_ONLY_REAL_AGENT_BRIDGE_CREDENTIAL",
  ARTFI_AGENT_API_URL: "http://127.0.0.1:33327",
  ARTFI_AGENT_TEST_ADAPTER_TOKEN: "TEST_ONLY_LOCAL_BROWSER_ADAPTER_CREDENTIAL",
  MYSQL_DSN: `${database.user}:${password}@tcp(${database.host}:${database.port})/${database.database}?parseTime=true&timeout=3s`,
  NEXT_PUBLIC_HOODI_RPC_URL: "http://127.0.0.1:3000/TEST_ONLY-hoodi-rpc",
};
const children = [];
async function run(command, args, cwd, label) {
  const log = await open(join(data, `${label}.log`), "w", 0o600);
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.once("error", () => {});
  children.push(child);
  await log.close();
  return child;
}
async function wait(url) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw Error("ISOLATED_SERVER_START_TIMEOUT");
}
async function exit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("ISOLATED_BROWSER_PROCESS_FAILED")),
    );
  });
}
try {
  if (!bundle) {
    const child = await run(
      process.env.GO_BINARY || "go",
      ["build", "-o", api, "./cmd/server"],
      join(root, "apps/api"),
      "agent-browser-api-build",
    );
    await exit(child);
  }
  await run(api, [], root, "agent-browser-api");
  await wait("http://127.0.0.1:8080/healthz");
  await run(
    process.execPath,
    [join(root, "apps/agent-runtime/test/browser-adapter-fixture.mjs")],
    root,
    "agent-browser-adapter",
  );
  await wait("http://127.0.0.1:33328/test-only/info");
  const tokenFile = join(data, "browser-adapter-token");
  await writeFile(tokenFile, env.ARTFI_AGENT_TEST_ADAPTER_TOKEN, {
    mode: 0o600,
  });
  const agentConfig = join(data, "browser-agent-config.json");
  await writeFile(
    agentConfig,
    JSON.stringify({
      schemaVersion: 1,
      mode: "TEST_ONLY_NO_REAL_VALUE",
      listen: { host: "127.0.0.1", port: 33327 },
      webOrigin: env.ARTFI_WEB_URL,
      authentication: { apiURL: env.ARTFI_API_URL },
      database,
      adapter: {
        kind: "artfi-isolated-test-v1",
        baseURL: "http://127.0.0.1:33328",
        tokenFile,
      },
      worker: { intervalMs: 100 },
    }),
    { mode: 0o600 },
  );
  env.ARTFI_AGENT_CONFIG_FILE = agentConfig;
  await run(
    node,
    [
      bundle
        ? join(bundle, "runtime/agent/src/server.mjs")
        : join(root, "apps/agent-runtime/src/server.mjs"),
    ],
    root,
    "agent-browser-runtime",
  );
  await wait("http://127.0.0.1:33327/healthz");
  await run(
    node,
    bundle
      ? [join(bundle, "runtime/web/apps/web/server.js")]
      : [
          join(root, "apps/web/node_modules/next/dist/bin/next"),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3000",
        ],
    bundle ? join(bundle, "runtime/web/apps/web") : join(root, "apps/web"),
    "agent-browser-web",
  );
  await wait(`${env.ARTFI_WEB_URL}/agent`);
  const report = join(data, "agent-browser.json");
  const testEnv = {
    ...env,
    ARTFI_E2E_BASE_URL: env.ARTFI_WEB_URL,
    ARTFI_AGENT_REAL_BROWSER_FIXTURE: "1",
    PLAYWRIGHT_JSON_OUTPUT_FILE: report,
  };
  const result = spawn(
    process.execPath,
    [
      join(root, "apps/web/node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/agent-runtime-live.spec.ts",
      "--workers=1",
      "--reporter=json",
    ],
    {
      cwd: join(root, "apps/web"),
      env: testEnv,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await exit(result);
  console.log(
    JSON.stringify({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      result: "PASSED_REAL_SESSION_BFF_AGENT_MYSQL_BROWSER",
      report,
    }),
  );
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(3000),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}
