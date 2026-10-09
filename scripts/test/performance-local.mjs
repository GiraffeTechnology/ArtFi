#!/usr/bin/env node
/** Finite TEST_ONLY performance profile. Starts and stops every service in one process namespace. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, constants } from "node:fs";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  mkdtemp,
  rm,
  access,
} from "node:fs/promises";
import {
  hostname,
  cpus,
  totalmem,
  freemem,
  loadavg,
  availableParallelism,
} from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { renderCluster } from "../operations/cluster-config.mjs";
import {
  freePort,
  mapLimited,
  requestBudget,
  sha256,
  stop,
  summary,
  waitFor,
} from "./performance-common.mjs";
import { runLocalTrades } from "./performance-local-chain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flags = new Map();
const acceptedFlags = new Set([
  "--smoke",
  "--measurement-window-approved",
  "--bundle-root",
  "--api-binary",
  "--mysql-base",
  "--nginx",
  "--anvil",
  "--output-root",
  "--duration-seconds",
  "--max-requests",
]);
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  assert.ok(
    acceptedFlags.has(name) && !flags.has(name),
    "Unknown or duplicate argument.",
  );
  flags.set(
    name,
    ["--smoke", "--measurement-window-approved"].includes(name)
      ? true
      : process.argv[++i],
  );
}
function required(name) {
  const value = flags.get(name);
  assert.equal(typeof value, "string", `${name} is required.`);
  return resolve(value);
}
const bundle = required("--bundle-root"),
  apiBinary = required("--api-binary"),
  mysqlBase = required("--mysql-base"),
  nginx = required("--nginx"),
  anvil = required("--anvil"),
  outputRoot = required("--output-root");
const smoke = flags.has("--smoke");
assert.ok(
  smoke || flags.has("--measurement-window-approved"),
  "Coordinate a quiet resource window before a measured profile.",
);
const users = smoke ? 4 : 100,
  tradesPerKind = smoke ? 2 : 50,
  rounds = smoke ? 2 : 12;
const durationSeconds = flags.has("--duration-seconds")
  ? Number(flags.get("--duration-seconds"))
  : 0;
const requestCap = flags.has("--max-requests")
  ? Number(flags.get("--max-requests"))
  : 90000;
assert.ok(
  Number.isInteger(durationSeconds) &&
    durationSeconds >= 0 &&
    durationSeconds <= 60,
  "Optional duration must be 1–60 seconds (or omitted).",
);
assert.ok(
  !smoke || durationSeconds === 0,
  "Smoke cannot run the 100-user duration profile.",
);
assert.ok(
  Number.isInteger(requestCap) && requestCap >= 100 && requestCap <= 150000,
  "Request cap must be 100–150000 per surface.",
);
assert.ok(
  !flags.has("--max-requests") || durationSeconds > 0,
  "A request cap applies only to the optional duration profile.",
);
await mkdir(outputRoot, { recursive: true });
const directory = await mkdtemp(join(outputRoot, "performance-local-"));
const children = [],
  streams = [];
const baseEnv = {
  PATH: process.env.PATH,
  HOME: directory,
  TMPDIR: directory,
  LANG: "C.UTF-8",
  LD_LIBRARY_PATH: `${mysqlBase}/usr/lib/x86_64-linux-gnu:${mysqlBase}/lib/private`,
};
const serviceVersions = {};
function launch(name, command, args, extraEnv = {}, cwd, silent = false) {
  const child = spawn(command, args, {
    cwd,
    env: { ...baseEnv, ...extraEnv },
    stdio: ["ignore", silent ? "ignore" : "pipe", silent ? "ignore" : "pipe"],
  });
  child.on("error", () => {});
  children.push(child);
  if (!silent) {
    const stream = createWriteStream(join(directory, `${name}.log`));
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    streams.push(stream);
  }
  return child;
}
const startedAt = new Date().toISOString();
const report = {
  format: 1,
  purpose: "TEST_ONLY isolated finite NFR regression",
  startedAt,
  smoke,
  outcome: "incomplete",
  evidenceDirectory: directory,
  workload: {
    users,
    tradesPerKind,
    rounds,
    optionalDurationSeconds: durationSeconds,
    optionalRequestCapPerSurface: durationSeconds ? requestCap : null,
    thinkTimeMs: 0,
    rate: "Closed-loop: one outstanding request per user; no additional rate limit.",
    profilesRunSequentially: true,
    retriesDuringMeasurements: 0,
    percentileMethod:
      "nearest rank over all completed requests including HTTP errors",
  },
  productionAcceptance: false,
  availability48Hours: "not run",
  noHILSoak: "not run",
  excluded: [
    "public-chain finality and congestion",
    "production hardware/network/TLS",
    "OpenSea settlement",
    "page rendering/load",
    "wallet-provider connection UI",
    "independent security review",
    "native RWA issuance",
  ],
  measurements: [],
};
try {
  for (const executable of [
    apiBinary,
    nginx,
    anvil,
    join(mysqlBase, "bin/mysqld"),
    join(mysqlBase, "bin/mysql"),
    join(bundle, "runtime/bin/node"),
  ])
    await access(executable, constants.X_OK);
  const [mysqlPort, chainPort, wl, wa, wb, al, aa, ab] = await Promise.all(
    Array.from({ length: 8 }, freePort),
  );
  const origin = `http://127.0.0.1:${wl}`,
    apiURL = `http://127.0.0.1:${al}`;
  const webServer = join(bundle, "runtime/web/apps/web/server.js"),
    node = join(bundle, "runtime/bin/node");
  const migrationRoot = join(bundle, "migrations");
  const migrations = (await readdir(migrationRoot))
    .filter((file) => file.endsWith(".up.sql"))
    .sort();
  serviceVersions.node = execFileSync(node, ["--version"], {
    encoding: "utf8",
    env: baseEnv,
  }).trim();
  serviceVersions.mysql = execFileSync(
    join(mysqlBase, "bin/mysqld"),
    ["--version"],
    { encoding: "utf8", env: baseEnv },
  ).trim();
  serviceVersions.anvil = execFileSync(anvil, ["--version"], {
    encoding: "utf8",
    env: baseEnv,
  }).trim();
  serviceVersions.nginx =
    "Binary digest recorded; inspect nginx -v for version (written on stderr).";
  report.environment = {
    hostname: hostname(),
    architecture: process.arch,
    platform: process.platform,
    logicalCPUs: cpus().length,
    cpuModel: cpus()[0]?.model,
    totalMemoryBytes: totalmem(),
    availableParallelism: availableParallelism(),
    freeMemoryAtStartBytes: freemem(),
    loadAverageAtStart: loadavg(),
    versions: serviceVersions,
    externalChainAccess: false,
    topology:
      "one synthetic MySQL, two actual Go API processes, two packaged Next web processes, one actual Nginx, one no-fork Anvil",
  };
  report.artifacts = {
    apiBinary: { path: apiBinary, sha256: await sha256(apiBinary) },
    bundleRoot: bundle,
    bundleSourceManifestSHA256: await sha256(
      join(bundle, "source-manifest.json"),
    ),
    dependencyLockSHA256: await sha256(join(root, "pnpm-lock.yaml")),
    clusterConfigRendererSHA256: await sha256(
      join(root, "scripts/operations/cluster-config.mjs"),
    ),
    webServerSHA256: await sha256(webServer),
    nodeSHA256: await sha256(node),
    nginxSHA256: await sha256(nginx),
    anvilSHA256: await sha256(anvil),
    migrations: await Promise.all(
      migrations.map(async (file) => ({
        file,
        sha256: await sha256(join(migrationRoot, file)),
      })),
    ),
    harness: await Promise.all(
      [
        "performance-common.mjs",
        "performance-local-chain.mjs",
        "performance-local.mjs",
      ].map(async (file) => ({
        file,
        sha256: await sha256(join(root, "scripts/test", file)),
      })),
    ),
  };
  // Chain setup and settlement are real local EVM transactions, never API acknowledgments.
  const chain = await runLocalTrades({
    root,
    rpcURL: `http://127.0.0.1:${chainPort}`,
    count: tradesPerKind,
    launch,
    anvil,
    port: chainPort,
  });
  report.localChain = chain.publicResult;
  await writeFile(
    join(directory, "local-chain-results.json"),
    JSON.stringify(chain.publicResult, null, 2),
  );
  await mkdir(join(directory, "mysql-data"));
  execFileSync(
    join(mysqlBase, "bin/mysqld"),
    [
      "--no-defaults",
      "--initialize-insecure",
      `--basedir=${mysqlBase}`,
      `--datadir=${join(directory, "mysql-data")}`,
      `--log-error=${join(directory, "mysql-initialize.log")}`,
    ],
    { env: baseEnv, stdio: "pipe" },
  );
  launch("mysql", join(mysqlBase, "bin/mysqld"), [
    "--no-defaults",
    `--basedir=${mysqlBase}`,
    `--datadir=${join(directory, "mysql-data")}`,
    "--socket=",
    `--pid-file=${join(directory, "mysql.pid")}`,
    "--bind-address=127.0.0.1",
    `--port=${mysqlPort}`,
    "--mysqlx=OFF",
    `--log-error=${join(directory, "mysql-server.log")}`,
  ]);
  const mysqlArgs = [
    "--no-defaults",
    "--protocol=TCP",
    "-h127.0.0.1",
    `-P${mysqlPort}`,
    "-uroot",
    "--batch",
    "--skip-column-names",
  ];
  function sql(command, database = false) {
    return execFileSync(
      join(mysqlBase, "bin/mysql"),
      [...mysqlArgs, ...(database ? ["artfi_performance_test_only"] : [])],
      {
        input: command,
        env: baseEnv,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }
  await waitFor(() => {
    sql("SELECT 1;");
    return true;
  }, "isolated MySQL");
  sql("CREATE DATABASE artfi_performance_test_only;");
  for (const file of migrations)
    sql(await readFile(join(migrationRoot, file), "utf8"), true);
  report.environment.databaseTables = Number(
    sql(
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();",
      true,
    ).trim(),
  );
  const shared = {
    NODE_ENV: "production",
    ARTFI_WEB_URL: origin,
    ARTFI_WEB_ORIGIN: origin,
    ARTFI_API_URL: apiURL,
    ARTFI_USER_AUTH_API_URL: apiURL,
    ARTFI_USER_AUTH_CHAIN_IDS: "560048",
    MYSQL_DSN: `root@tcp(127.0.0.1:${mysqlPort})/artfi_performance_test_only?parseTime=true`,
    ARTFI_USER_SESSION_SECRET: `TEST_ONLY_${randomBytes(32).toString("hex")}`,
    ARTFI_USER_AUTH_BRIDGE_TOKEN: `TEST_ONLY_${randomBytes(32).toString("hex")}`,
    ARTFI_INDEXER_SHARED_KEY: `TEST_ONLY_${randomBytes(32).toString("hex")}`,
  };
  for (const [name, p] of [
    ["api-a", aa],
    ["api-b", ab],
  ])
    launch(name, apiBinary, [], {
      ...shared,
      ARTFI_API_ADDR: `127.0.0.1:${p}`,
    });
  for (const [name, p] of [
    ["web-a", wa],
    ["web-b", wb],
  ])
    launch(
      name,
      node,
      [webServer],
      { ...shared, HOSTNAME: "127.0.0.1", PORT: String(p) },
      dirname(webServer),
    );
  for (const p of [aa, ab])
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${p}/readyz`)).ok,
      "Go API",
    );
  for (const p of [wa, wb])
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${p}/api/health`)).ok,
      "packaged web",
    );
  for (const d of ["logs", "client-body", "proxy"])
    await mkdir(join(directory, d));
  await writeFile(
    join(directory, "nginx.conf"),
    renderCluster({
      format: 1,
      purpose: "isolated-test",
      runtimeDirectory: directory,
      web: {
        listen: `127.0.0.1:${wl}`,
        backends: [`127.0.0.1:${wa}`, `127.0.0.1:${wb}`],
      },
      api: {
        listen: `127.0.0.1:${al}`,
        backends: [`127.0.0.1:${aa}`, `127.0.0.1:${ab}`],
      },
    }),
  );
  launch("nginx", nginx, [
    "-p",
    `${directory}/`,
    "-c",
    join(directory, "nginx.conf"),
    "-g",
    "daemon off; master_process off;",
  ]);
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, "Nginx");
  async function json(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    assert.ok(
      response.ok,
      `${new URL(url).pathname} HTTP ${response.status}: ${body.detail || "unexpected response"}`,
    );
    return { response, body };
  }
  async function login(wallet) {
    const jar = new Map();
    async function auth(action, body) {
      const result = await json(`${origin}/api/user/auth/${action}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
        },
        body: JSON.stringify(body),
      });
      for (const cookie of result.response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0],
          eq = pair.indexOf("=");
        if (pair.slice(eq + 1)) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        else jar.delete(pair.slice(0, eq));
      }
      return result.body;
    }
    const challenge = await auth("challenge", {
      address: wallet.address,
      chainId: 560048,
    });
    const verified = await auth("verify", {
      address: challenge.address,
      chainId: 560048,
      signature: await wallet.signMessage(challenge.message),
    });
    assert.equal(
      verified.session.address.toLowerCase(),
      wallet.address.toLowerCase(),
    );
    assert.ok(jar.has("artfi_user_access"));
    return {
      address: wallet.address.toLowerCase(),
      sessionID: verified.session.id,
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
      token: decodeURIComponent(jar.get("artfi_user_access")),
    };
  }
  const accounts = await mapLimited(chain.buyers, 4, login);
  assert.equal(accounts.length, users);
  assert.equal(
    new Set(accounts.map((account) => account.sessionID)).size,
    users,
  );
  const sellerSession = await login(chain.seller);
  for (const order of chain.orders)
    await json(`${apiURL}/v1/indexer/signed-orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Indexer-Key": shared.ARTFI_INDEXER_SHARED_KEY,
        Authorization: `Bearer ${sellerSession.token}`,
      },
      body: JSON.stringify(order),
    });
  for (const event of chain.events)
    await json(`${apiURL}/v1/indexer/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Indexer-Key": shared.ARTFI_INDEXER_SHARED_KEY,
      },
      body: JSON.stringify(event),
    });
  report.dataset = {
    distinctSignedWalletSessions: accounts.length,
    settledOrders: chain.orders.length,
    actualLocalReceiptEvents: chain.events.length,
    databaseEventCount: Number(
      sql("SELECT COUNT(*) FROM chain_events;", true).trim(),
    ),
    portfolioHistoryScope:
      "Indexed settlement receipts only; setup minting history is intentionally outside this profile.",
    cache:
      "No Redis; SQL-backed portfolio reads and durable session verification.",
  };
  async function profile(
    surface,
    measuredRounds,
    warmup = false,
    durationMs = 0,
  ) {
    const samples = [],
      errors = [];
    let inFlight = 0,
      peakInFlight = 0;
    const begin = performance.now();
    const budget = requestBudget({
      limit: durationMs ? requestCap : users * measuredRounds * 3,
      durationMs,
    });
    await Promise.all(
      accounts.map(async (account, userIndex) => {
        for (
          let sequence = 0;
          (durationMs || sequence < measuredRounds * 3) && budget.take();
          sequence++
        ) {
          const round = Math.floor(sequence / 3),
            offset = sequence % 3;
          const name = ["session", "orders", "portfolio"][
            (userIndex + round + offset) % 3
          ];
          const target = surface === "api" ? apiURL : origin;
          const path =
            name === "session"
              ? surface === "api"
                ? "/v1/user/auth/session"
                : "/api/user/auth/session"
              : name === "orders"
                ? `${surface === "api" ? "/v1" : "/api"}/orders?pageSize=20`
                : `${surface === "api" ? "/v1" : "/api"}/portfolio/${account.address}`;
          const headers = {
            ...(surface === "web-bff"
              ? { Cookie: account.cookie }
              : { Authorization: `Bearer ${account.token}` }),
          };
          let options = { headers };
          if (surface === "api" && name === "session")
            options = {
              method: "POST",
              headers: {
                Authorization: `Bearer ${shared.ARTFI_USER_AUTH_BRIDGE_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ accessToken: account.token }),
            };
          const start = performance.now();
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          let status = 0,
            error;
          try {
            const response = await fetch(`${target}${path}`, {
              ...options,
              signal: AbortSignal.timeout(10000),
            });
            status = response.status;
            const body = await response.json();
            assert.equal(response.status, 200);
            if (name === "session")
              assert.equal(body.session.id, account.sessionID);
            if (name === "orders") {
              assert.equal(body.total, users);
              assert.equal(body.data.length, Math.min(20, users));
            }
            if (name === "portfolio") {
              assert.equal(body.address, account.address);
              assert.ok(body.transactions.length >= 2);
              assert.ok(body.positions.length >= 1);
              assert.ok(body.notifications.length >= 2);
            }
          } catch (failure) {
            error = failure.name || "Error";
            errors.push({ userIndex, round, endpoint: name, status, error });
          } finally {
            inFlight--;
          }
          samples.push({
            endpoint: name,
            durationMs: performance.now() - start,
            status,
            ...(error ? { error } : {}),
          });
        }
      }),
    );
    const wallMs = performance.now() - begin;
    const result = {
      surface,
      mode: durationMs ? "duration" : "burst",
      requestedDurationMs: durationMs || null,
      requestCap: durationMs ? requestCap : users * measuredRounds * 3,
      terminationReason: durationMs ? budget.stopReason : "fixed-rounds",
      requestedDurationCompleted: durationMs
        ? budget.stopReason === "duration"
        : null,
      distinctConcurrentUsers: users,
      peakInFlight,
      requests: samples.length,
      wallMs,
      requestsPerSecond: (samples.length * 1000) / wallMs,
      errorCount: errors.length,
      allRequests: summary(samples.map((sample) => sample.durationMs)),
      endpoints: Object.fromEntries(
        ["session", "orders", "portfolio"].map((name) => [
          name,
          summary(
            samples
              .filter((sample) => sample.endpoint === name)
              .map((sample) => sample.durationMs),
          ),
        ]),
      ),
      errors,
    };
    result.localThresholdMet =
      errors.length === 0 &&
      peakInFlight === users &&
      Object.values(result.endpoints).every((endpoint) => endpoint.p95Ms < 500);
    if (!warmup) {
      report.measurements.push(result);
      await writeFile(
        join(
          directory,
          `${durationMs ? "duration-" : ""}${surface}-samples.json`,
        ),
        JSON.stringify(samples),
      );
      console.log(JSON.stringify({ phase: "http-profile", ...result }));
    } else
      assert.equal(
        errors.length,
        0,
        "Warmup correctness must pass before measurement.",
      );
    return result;
  }
  await profile("api", 1, true);
  await profile("web-bff", 1, true);
  await profile("api", rounds);
  await profile("web-bff", rounds);
  if (durationSeconds) {
    await profile("api", 0, false, durationSeconds * 1000);
    await profile("web-bff", 0, false, durationSeconds * 1000);
  }
  const accessLog = (await readFile(join(directory, "access.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  report.balancer = {
    allFourBackendsObserved: [wa, wb, aa, ab].every((port) =>
      accessLog.some((record) => record.upstream.includes(String(port))),
    ),
    requestRecords: accessLog.length,
  };
  assert.ok(report.balancer.allFourBackendsObserved);
  report.outcome = smoke
    ? "smoke-passed-not-NFR-acceptance"
    : [...report.measurements, ...report.localChain.profiles].every(
          (profile) => profile.localThresholdMet,
        )
      ? "local-profile-thresholds-met"
      : "local-profile-thresholds-not-met";
  if (!smoke && report.outcome.endsWith("not-met")) process.exitCode = 2;
  if (
    report.measurements.some(
      (profile) =>
        profile.mode === "duration" && !profile.requestedDurationCompleted,
    )
  ) {
    report.outcome = "request-cap-reached-before-duration";
    process.exitCode = 2;
  }
} catch (error) {
  report.outcome = "failed";
  // Never serialize ethers error objects: they can contain raw signed transaction inputs.
  report.failure = {
    name: error.name,
    code: error.code,
    message: error.shortMessage || error.message?.slice(0, 600),
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  for (const stream of streams)
    await new Promise((resolve) => stream.end(resolve));
  report.finishedAt = new Date().toISOString();
  report.loadAverageAtFinish = loadavg();
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  // This directory was created by this run; remove only its disposable synthetic database.
  await rm(join(directory, "mysql-data"), { recursive: true, force: true });
  console.log(
    JSON.stringify({ outcome: report.outcome, evidenceDirectory: directory }),
  );
}
