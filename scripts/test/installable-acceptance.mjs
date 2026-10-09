#!/usr/bin/env node
/** Artifact-first acceptance. No source compilation, downloads or live-chain calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkInstalledBrowser } from "./installable-browser-check.mjs";

const help = `Usage: node scripts/test/installable-acceptance.mjs
  --artifact /delivery/artfi-RELEASE-linux-x64.tar.gz
  --checksum /delivery/artfi-RELEASE-linux-x64.tar.gz.sha256
  --mysql-basedir /opt/mysql-8.4
  --evidence-dir /private/artfi-acceptance-UNIQUE
  [--mysql-client /opt/mysql-8.4/bin/mysql]
  [--mysql-library-path /opt/mysql-8.4/lib/private]
  [--expected-migrations 14]
  [--playwright-module /test-tools/node_modules/@playwright/test/index.mjs]
  [--chromium-executable /test-tools/chrome-headless-shell]
  [--require-browser]
  [--systemd-analyze /usr/bin/systemd-analyze]

Linux and Node 24+ are required on the test host. Supply official MySQL 8.4+
binaries. The evidence directory must not exist and must be outside this source
checkout. The harness creates its own empty MySQL data directory, ephemeral
loopback ports and installation prefix. It never connects to an existing DB.
All tests and services run in this one process/session. No Docker is required.
The application always runs from the archive using its bundled Node/Go binaries.
The TEST_ONLY evidence is private; it is not part of the reusable source tools.
`;

export function parseArguments(args) {
  const accepted = new Set([
    "artifact",
    "checksum",
    "mysql-basedir",
    "mysql-client",
    "mysql-library-path",
    "evidence-dir",
    "expected-migrations",
    "playwright-module",
    "chromium-executable",
    "require-browser",
    "systemd-analyze",
    "help",
  ]);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (
      !args[i].startsWith("--") ||
      !accepted.has(key) ||
      Object.hasOwn(result, key)
    )
      throw new Error(`Unknown or repeated option: ${args[i]}`);
    if (["help", "require-browser"].includes(key)) result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for --${key}`);
      result[key] = args[++i];
    }
  }
  if (result.help) return result;
  for (const key of ["artifact", "checksum", "mysql-basedir", "evidence-dir"])
    if (!result[key]) throw new Error(`Required option --${key} is missing`);
  const count = Number(result["expected-migrations"] ?? "14");
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("--expected-migrations must be a positive integer");
  result["expected-migrations"] = count;
  if (result["require-browser"] && !result["playwright-module"])
    throw new Error("--require-browser requires --playwright-module");
  if (result["chromium-executable"] && !result["playwright-module"])
    throw new Error("--chromium-executable requires --playwright-module");
  return result;
}

export function archiveRoot(listing) {
  const names = listing.trim().split("\n").filter(Boolean);
  if (!names.length) throw new Error("Archive is empty");
  for (const name of names) {
    if (
      isAbsolute(name) ||
      name.includes("\\") ||
      name.split("/").includes("..")
    )
      throw new Error("Archive contains an invalid path");
  }
  const roots = new Set(names.map((name) => name.split("/")[0]));
  if (roots.size !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test([...roots][0]))
    throw new Error("Expected one named release directory in the archive");
  return [...roots][0];
}

export function expectedChecksum(text, filename) {
  const lines = text.trim().split("\n");
  const match =
    lines.length === 1 && /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(lines[0]);
  if (!match || match[2] !== filename)
    throw new Error("Checksum sidecar must name this exact archive");
  return match[1].toLowerCase();
}

export async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
const readJSON = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJSON = async (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const present = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
async function unusedPort(reserved) {
  for (;;) {
    const server = createServer();
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const port = server.address().port;
    await new Promise((accept) => server.close(accept));
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}
export function summaryStatus(checks) {
  if (checks.some((check) => check.result === "FAILED")) return "FAILED";
  return checks.some((check) => check.required && check.result === "NOT_RUN")
    ? "NOT_RUN"
    : "PASSED";
}

export async function runAcceptance(options) {
  assert.equal(
    process.platform,
    "linux",
    "The installable artifact targets Linux",
  );
  assert.ok(
    Number(process.versions.node.split(".")[0]) >= 24,
    "Node 24+ test host required",
  );
  process.umask(0o077);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const artifact = await realpath(resolve(options.artifact));
  const checksum = await realpath(resolve(options.checksum));
  const mysqlBase = await realpath(resolve(options["mysql-basedir"]));
  const evidence = resolve(options["evidence-dir"]);
  const parent = await realpath(dirname(evidence));
  const sourceRelative = relative(
    await realpath(source),
    join(parent, basename(evidence)),
  );
  if (
    !sourceRelative ||
    (sourceRelative !== ".." &&
      !sourceRelative.startsWith("../") &&
      !isAbsolute(sourceRelative))
  )
    throw new Error(
      "Keep private acceptance evidence outside the source checkout",
    );
  await mkdir(evidence, { mode: 0o700 }); // Never adopt or overwrite an existing directory.
  const prefix = join(evidence, "installation");
  const logs = join(evidence, "logs");
  await mkdir(logs);
  const report = {
    format: 1,
    scope:
      "TEST_ONLY precompiled Linux installation lifecycle; no production or real-value execution",
    startedAt: new Date().toISOString(),
    artifact: { filename: basename(artifact) },
    testHost: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
    },
    checks: [],
  };
  const phases = [
    "artifact-integrity-and-inventory",
    "fresh-mysql",
    "install-without-persistence",
    "forward-migrations",
    "idempotent-migrations",
    "database-backed-services",
    "runtime-config-default",
    "runtime-config-changed",
    "runtime-config-reset",
    "optional-agent-and-monitor",
    "synthetic-additive-upgrade",
    "application-rollback-retains-schema",
    "systemd-template-generation",
    "systemd-template-parser",
    "migration-checksum-guard",
    "migration-dirty-ledger-guard",
    "final-artifact-integrity",
    "managed-process-stop",
  ];
  report.checks = phases.map((name) => ({
    name,
    result: "NOT_RUN",
    required: true,
  }));
  for (const label of ["default", "changed", "reset"])
    report.checks.push({
      name: `browser-${label}`,
      result: "NOT_RUN",
      required: !!options["require-browser"],
    });
  report.checks.push({
    name: "live-external-integrations",
    result: "NOT_RUN",
    required: false,
    reason:
      "No real-chain, wallet signing, venue execution, production access or real-value operation is part of this test.",
  });
  const save = async () => {
    report.result = summaryStatus(report.checks);
    await writeJSON(join(evidence, "report.json"), report);
  };
  const resultFor = (name) => report.checks.find((item) => item.name === name);
  async function phase(name, fn) {
    const entry = resultFor(name);
    entry.startedAt = new Date().toISOString();
    try {
      const detail = await fn();
      Object.assign(entry, { result: "PASSED", ...(detail ? { detail } : {}) });
    } catch (error) {
      Object.assign(entry, { result: "FAILED", reason: String(error.message) });
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
      await save();
      console.log(`${entry.result}: ${name}`);
    }
  }
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: evidence,
    TMPDIR: process.env.TMPDIR || "/tmp",
    ...(options["mysql-library-path"]
      ? { LD_LIBRARY_PATH: options["mysql-library-path"] }
      : {}),
  };
  let commandCount = 0;
  async function command(
    exe,
    args,
    { label, expectedFailure = false, extraEnv = {}, timeout = 180000 } = {},
  ) {
    const logName = `${String(++commandCount).padStart(3, "0")}-${label || basename(exe)}.log`;
    const child = spawn(exe, args, {
      env: { ...env, ...extraEnv },
      cwd: evidence,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    let timer;
    const code = await new Promise((accept, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Timed out: ${label || basename(exe)}`));
      }, timeout);
      child.once("error", reject);
      child.once("exit", (status, signal) =>
        accept(status ?? `signal:${signal}`),
      );
    }).finally(() => clearTimeout(timer));
    await writeFile(
      join(logs, logName),
      `${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`,
      { mode: 0o600 },
    );
    if (expectedFailure ? code === 0 : code !== 0)
      throw new Error(
        `${label || basename(exe)} ${expectedFailure ? "unexpectedly succeeded" : `failed (${code})`}; inspect logs/${logName}`,
      );
    return { stdout, stderr, code, log: `logs/${logName}` };
  }
  let bundle,
    node,
    cli,
    manifest,
    mysqlProcess,
    mysqlLog,
    servicesMayRun = false;
  let originalSettings;
  const mysqld = join(mysqlBase, "bin/mysqld");
  const mysql = options["mysql-client"]
    ? await realpath(resolve(options["mysql-client"]))
    : join(mysqlBase, "bin/mysql");
  const reserved = new Set();
  const ports = Object.fromEntries(
    await Promise.all(
      ["mysql", "web", "api", "agent"].map(async (name) => [
        name,
        await unusedPort(reserved),
      ]),
    ),
  );
  const webURL = `http://127.0.0.1:${ports.web}`;
  const apiURL = `http://127.0.0.1:${ports.api}`;
  const agentURL = `http://127.0.0.1:${ports.agent}`;
  const database = `artfi_installable_test_${process.pid}`;
  const dsn = `root@tcp(127.0.0.1:${ports.mysql})/${database}?parseTime=true&timeout=5s`;
  const mysqlArgs = [
    "--no-defaults",
    "--protocol=TCP",
    "--host=127.0.0.1",
    `--port=${ports.mysql}`,
    "--user=root",
    "--batch",
    "--skip-column-names",
  ];
  const query = (sql, label, selected = true) =>
    command(
      mysql,
      [...mysqlArgs, ...(selected ? [database] : []), "--execute", sql],
      { label },
    );
  const cliCommand = (action, args = [], options = {}, root = bundle) =>
    command(
      join(root, "runtime/bin/node"),
      [
        join(root, "tools/install/artfi.mjs"),
        action,
        "--prefix",
        prefix,
        ...args,
      ],
      { label: action, ...options },
    );
  async function configure(input, label) {
    const file = join(evidence, `${label}.json`);
    await writeJSON(file, input);
    await cliCommand("configure", ["--input", file]);
    await cliCommand("validate");
  }
  async function start() {
    servicesMayRun = true;
    return cliCommand("start");
  }
  async function stop() {
    await cliCommand("stop");
    servicesMayRun = false;
  }
  async function verify() {
    const result = await cliCommand("verify", ["--require-database"]);
    const output = JSON.parse(result.stdout);
    for (const name of [
      "database-migrations",
      "api-primary-readiness",
      "persistent-orders-read",
    ])
      assert.equal(
        output.checks.find((item) => item.name === name)?.result,
        "PASSED",
      );
    return { report: result.log, checks: output.checks };
  }
  async function browser(label, apiBase, rpcURL) {
    if (!options["playwright-module"]) {
      resultFor(`browser-${label}`).reason =
        "No preinstalled Playwright module supplied; browser checks were not run.";
      return;
    }
    await phase(`browser-${label}`, () =>
      checkInstalledBrowser({
        baseURL: webURL,
        apiBase,
        rpcURL,
        label,
        playwrightModule: resolve(options["playwright-module"]),
        chromiumExecutable:
          options["chromium-executable"] &&
          resolve(options["chromium-executable"]),
        outputDirectory: join(evidence, "screenshots"),
      }),
    );
  }
  async function runtimeConfig(
    label,
    { apiBase = "", rpcURL = "", walletURL = "" } = {},
  ) {
    const response = await fetch(webURL, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    const found = /window\.__ARTFI_PUBLIC_CONFIG__=(\{.*?\});/.exec(html);
    assert.ok(found, "Installed HTML must contain public runtime bootstrap");
    const config = JSON.parse(found[1]);
    assert.equal(config.NEXT_PUBLIC_API_URL || "", apiBase);
    assert.equal(config.NEXT_PUBLIC_BASE_RPC_URL || "", rpcURL);
    assert.ok(
      Object.keys(config).every((key) => key.startsWith("NEXT_PUBLIC_")),
    );
    const wallet = await fetch(`${webURL}/api/wallet-config`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(wallet.status, 200);
    assert.match(wallet.headers.get("cache-control") || "", /no-store/);
    assert.deepEqual(
      await wallet.json(),
      walletURL
        ? { ok: true, url: walletURL }
        : { ok: false, code: "NOT_CONFIGURED" },
    );
    const currentSettings = await readJSON(join(prefix, "shared/config.json"));
    for (const name of [
      "ARTFI_USER_SESSION_SECRET",
      "ARTFI_USER_AUTH_BRIDGE_TOKEN",
      "ARTFI_AGENT_BRIDGE_TOKEN",
    ])
      assert.equal(
        currentSettings[name],
        originalSettings[name],
        "Reconfiguration must preserve generated secrets",
      );
    await browser(label, apiBase, rpcURL);
    return {
      publicAPIBase: apiBase,
      publicRPCURL: rpcURL,
      walletConfigured: !!walletURL,
      walletNoStore: true,
    };
  }
  async function stoppedRecords() {
    for (const name of ["web", "api", "agent", "monitor", "mirror"])
      assert.equal(
        await present(join(prefix, "shared/run", `${name}.json`)),
        false,
        `${name} PID record must be removed`,
      );
  }
  try {
    await phase("artifact-integrity-and-inventory", async () => {
      const digest = await fileHash(artifact);
      assert.equal(
        digest,
        expectedChecksum(await readFile(checksum, "utf8"), basename(artifact)),
      );
      report.artifact.sha256 = digest;
      report.artifact.bytes = (await stat(artifact)).size;
      report.artifact.checksumSidecarSha256 = await fileHash(checksum);
      await copyFile(checksum, join(evidence, "archive.sha256"));
      const list = await command("tar", ["-tzf", artifact], {
        label: "archive-list",
      });
      const extracted = join(evidence, "extracted");
      await mkdir(extracted);
      bundle = join(extracted, archiveRoot(list.stdout));
      await command(
        "tar",
        [
          "-xzf",
          artifact,
          "--no-same-owner",
          "--no-same-permissions",
          "-C",
          extracted,
        ],
        { label: "archive-extract" },
      );
      node = join(bundle, "runtime/bin/node");
      cli = join(bundle, "tools/install/artfi.mjs");
      await cliCommand("check-bundle");
      manifest = await readJSON(join(bundle, "manifest.json"));
      assert.equal(manifest.migrations, options["expected-migrations"]);
      const forwardFiles = Object.keys(manifest.files).filter((name) =>
        name.endsWith(".up.sql"),
      );
      assert.equal(forwardFiles.length, manifest.migrations);
      for (const name of forwardFiles)
        assert.ok(
          Object.hasOwn(
            manifest.files,
            name.replace(/\.up\.sql$/, ".down.sql"),
          ),
          `Reverse migration missing: ${name}`,
        );
      assert.equal(manifest.platform, process.platform);
      assert.equal(manifest.architecture, process.arch);
      assert.match(
        (await command(node, ["--version"], { label: "bundled-node-version" }))
          .stdout,
        /^v24\./,
      );
      for (const name of [
        "runtime/bin/artfi-api",
        "runtime/bin/artfi-migrate",
        "runtime/web/apps/web/server.js",
        "runtime/mirror/dist/index.js",
        "runtime/agent/src/server.mjs",
        "tools/operations/monitor.mjs",
        "tools/operations/mysql-recovery.mjs",
        "tools/operations/cluster-config.mjs",
        "contracts/inventory.json",
      ])
        assert.ok(
          Object.hasOwn(manifest.files, name),
          `Required built component missing: ${name}`,
        );
      const contracts = await readJSON(
        join(bundle, "contracts/inventory.json"),
      );
      assert.equal(contracts.sourceFingerprint, manifest.source.fingerprint);
      assert.ok(contracts.contracts.length > 0);
      for (const name of [
        "RWARegistry",
        "ArtFiMarket",
        "WholeArtworkMarket",
        "ArtFiAdminSafe",
      ])
        assert.ok(contracts.contracts.some((item) => item.name === name));
      for (const contract of contracts.contracts) {
        const built = await readJSON(
          join(bundle, "contracts", contract.artifact),
        );
        assert.ok(Array.isArray(built.abi));
        if (contract.deployable)
          assert.ok(
            typeof built.bytecode?.object === "string" &&
              built.bytecode.object.length > 2,
          );
        assert.ok(
          Object.hasOwn(manifest.files, `contracts/${contract.artifact}`),
        );
      }
      report.artifact.release = manifest.release;
      report.artifact.source = manifest.source;
      report.artifact.manifestSha256 = await fileHash(
        join(bundle, "manifest.json"),
      );
      await copyFile(
        join(bundle, "manifest.json"),
        join(evidence, "tested-manifest.json"),
      );
      await copyFile(
        join(bundle, "source-manifest.json"),
        join(evidence, "tested-source-manifest.json"),
      );
      await writeJSON(
        join(evidence, "harness-hashes.json"),
        Object.fromEntries(
          await Promise.all(
            ["installable-acceptance.mjs", "installable-browser-check.mjs"].map(
              async (name) => [
                name,
                await fileHash(
                  join(dirname(fileURLToPath(import.meta.url)), name),
                ),
              ],
            ),
          ),
        ),
      );
      return {
        manifestFiles: Object.keys(manifest.files).length,
        migrations: manifest.migrations,
        contractArtifacts: contracts.contracts.length,
      };
    });
    await phase("fresh-mysql", async () => {
      const version = (
        await command(mysqld, ["--version"], { label: "mysql-server-version" })
      ).stdout.trim();
      assert.match(version, /Ver (?:8\.(?:[4-9]|[1-9]\d)|9\.)/);
      report.testHost.mysql = {
        version,
        serverSha256: await fileHash(mysqld),
        clientSha256: await fileHash(mysql),
      };
      const data = join(evidence, "mysql-data");
      await mkdir(data);
      const baseArgs = [
        "--no-defaults",
        `--basedir=${mysqlBase}`,
        `--datadir=${data}`,
      ];
      await command(
        mysqld,
        [
          ...baseArgs,
          "--initialize-insecure",
          `--log-error=${join(logs, "mysql-initialize.log")}`,
        ],
        { label: "mysql-initialize" },
      );
      mysqlLog = await open(join(logs, "mysql-process.log"), "a", 0o600);
      mysqlProcess = spawn(
        mysqld,
        [
          ...baseArgs,
          "--socket=",
          "--mysqlx=OFF",
          "--bind-address=127.0.0.1",
          `--port=${ports.mysql}`,
          `--pid-file=${join(evidence, "mysql.pid")}`,
          `--log-error=${join(logs, "mysql-server.log")}`,
        ],
        { env, cwd: evidence, stdio: ["ignore", mysqlLog.fd, mysqlLog.fd] },
      );
      let spawnError;
      mysqlProcess.once("error", (error) => {
        spawnError = error;
      });
      let ready = false;
      for (let i = 0; i < 60; i++) {
        if (spawnError) throw spawnError;
        if (mysqlProcess.exitCode !== null)
          throw new Error(
            "Fresh MySQL exited before readiness; inspect mysql-server.log",
          );
        try {
          await query("SELECT 1", "mysql-readiness", false);
          ready = true;
          break;
        } catch {
          await sleep(500);
        }
      }
      assert.ok(ready, "Fresh MySQL must become ready");
      await query(
        `CREATE DATABASE ${database}`,
        "mysql-create-empty-database",
        false,
      );
      assert.equal(
        (
          await query(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()",
            "mysql-empty-database",
          )
        ).stdout.trim(),
        "0",
      );
      return {
        databaseWasEmpty: true,
        loopbackOnly: true,
        existingDatabaseUsed: false,
      };
    });
    await phase("install-without-persistence", async () => {
      await configure(
        {
          HOSTNAME: "127.0.0.1",
          PORT: String(ports.web),
          ARTFI_API_ADDR: `127.0.0.1:${ports.api}`,
          ARTFI_API_URL: apiURL,
          ARTFI_WEB_URL: webURL,
        },
        "initial-settings",
      );
      originalSettings = await readJSON(join(prefix, "shared/config.json"));
      assert.equal(
        (await stat(join(prefix, "shared/config.json"))).mode & 0o777,
        0o600,
      );
      await cliCommand("install");
      assert.equal(
        await present(join(prefix, "current")),
        false,
        "Install must not activate implicitly",
      );
      await cliCommand("activate", ["--release", manifest.release]);
      await start();
      const initial = JSON.parse((await cliCommand("verify")).stdout);
      assert.equal(
        initial.checks.find((item) => item.name === "database-migrations")
          ?.result,
        "NOT_RUN",
      );
      await cliCommand("verify", ["--require-database"], {
        expectedFailure: true,
        label: "verify-requires-database",
      });
      await stop();
      return {
        unconfiguredDatabase: "NOT_RUN",
        requireDatabaseRejected: true,
        configMode: "0600",
      };
    });
    let firstMigrations;
    await phase("forward-migrations", async () => {
      await configure({ MYSQL_DSN: dsn }, "database-settings");
      firstMigrations = JSON.parse((await cliCommand("migrate")).stdout);
      assert.equal(firstMigrations.pending, 0);
      assert.equal(
        firstMigrations.migrations.length,
        options["expected-migrations"],
      );
      assert.ok(
        firstMigrations.migrations.every((item) => item.applied && !item.dirty),
      );
      return { count: firstMigrations.migrations.length };
    });
    await phase("idempotent-migrations", async () => {
      const second = JSON.parse((await cliCommand("migrate")).stdout);
      assert.deepEqual(second, firstMigrations);
      return { unchangedLedger: true };
    });
    await phase("database-backed-services", async () => {
      await start();
      return verify();
    });
    await phase("runtime-config-default", () => runtimeConfig("default"));
    const changed = {
      apiBase: "/acceptance-configured-read",
      rpcURL: `http://127.0.0.1:${ports.api}/TEST_ONLY-unavailable-rpc`,
      walletURL: "https://wallet.example.test:9443/configured-path",
    };
    await phase("runtime-config-changed", async () => {
      await stop();
      await configure(
        {
          NEXT_PUBLIC_API_URL: changed.apiBase,
          NEXT_PUBLIC_BASE_RPC_URL: changed.rpcURL,
          ARTFI_XIONGAN_WALLET_URL: changed.walletURL,
        },
        "runtime-changed",
      );
      await start();
      await verify();
      return runtimeConfig("changed", changed);
    });
    await phase("runtime-config-reset", async () => {
      await stop();
      await configure(
        {
          NEXT_PUBLIC_API_URL: "",
          NEXT_PUBLIC_BASE_RPC_URL: "",
          ARTFI_XIONGAN_WALLET_URL: "",
        },
        "runtime-reset",
      );
      await start();
      await verify();
      return runtimeConfig("reset");
    });
    await phase("optional-agent-and-monitor", async () => {
      await stop();
      const agentFile = join(evidence, "agent-test-only.json");
      const monitorFile = join(evidence, "monitor-test-only.json");
      await writeJSON(agentFile, {
        schemaVersion: 1,
        mode: "TEST_ONLY_NO_REAL_VALUE",
        listen: { host: "127.0.0.1", port: ports.agent },
        webOrigin: webURL,
        authentication: { apiURL },
        database: null,
        adapter: { kind: "unavailable" },
        worker: { intervalMs: 1000 },
      });
      await writeJSON(monitorFile, {
        format: 1,
        intervalSeconds: 5,
        probes: [
          {
            name: "installed-api",
            kind: "http",
            url: `${apiURL}/healthz`,
            service: "artfi-api",
          },
          {
            name: "installed-web",
            kind: "http",
            url: `${webURL}/api/health`,
            service: "artfi-web",
          },
        ],
      });
      await configure(
        {
          ARTFI_AGENT_ENABLED: "true",
          ARTFI_AGENT_CONFIG_FILE: agentFile,
          ARTFI_AGENT_API_URL: agentURL,
          ARTFI_MONITOR_ENABLED: "true",
          ARTFI_MONITOR_CONFIG_FILE: monitorFile,
        },
        "optional-settings",
      );
      await start();
      await verify();
      let health;
      for (let i = 0; i < 40; i++) {
        try {
          const response = await fetch(`${agentURL}/healthz`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            health = await response.json();
            break;
          }
        } catch {}
        await sleep(250);
      }
      assert.equal(health?.mode, "TEST_ONLY_NO_REAL_VALUE");
      assert.equal(health?.state, "SAFE_DEGRADED");
      assert.equal(health?.productionReady, false);
      let observation;
      for (let i = 0; i < 30; i++) {
        const lines = (
          await readFile(join(prefix, "shared/logs/monitor.log"), "utf8")
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        observation = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter((value) => value?.type === "artfi-monitor")
          .at(-1);
        if (observation?.probes?.every((probe) => probe.status === "ok")) break;
        await sleep(500);
      }
      assert.equal(observation?.probes?.length, 2);
      assert.ok(observation.probes.every((probe) => probe.status === "ok"));
      await writeJSON(join(evidence, "optional-service-observations.json"), {
        agent: health,
        monitor: observation,
      });
      await stop();
      await stoppedRecords();
      await assert.rejects(
        fetch(`${agentURL}/healthz`, { signal: AbortSignal.timeout(1000) }),
        "Stopped agent must no longer listen",
      );
      await start();
      await verify();
      return {
        agent: health,
        monitor: {
          status: observation.status,
          probes: observation.probes,
          alerts: observation.alerts,
        },
        stopAndRestart: "PASSED",
      };
    });
    const syntheticRelease = "artfi-installable-acceptance-additive-test-only";
    const syntheticRoot = join(evidence, "synthetic-test-only-bundle");
    const syntheticMigration = "999999_installable_acceptance.up.sql";
    await phase("synthetic-additive-upgrade", async () => {
      await cp(bundle, syntheticRoot, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      const body =
        "CREATE TABLE installable_acceptance_sentinel (id INT PRIMARY KEY, label VARCHAR(80) NOT NULL);\nINSERT INTO installable_acceptance_sentinel VALUES (1, 'TEST_ONLY_PRESERVE_ON_APPLICATION_ROLLBACK');\n";
      await writeFile(
        join(syntheticRoot, "migrations", syntheticMigration),
        body,
      );
      const synthetic = structuredClone(manifest);
      synthetic.release = syntheticRelease;
      synthetic.migrations++;
      synthetic.files[`migrations/${syntheticMigration}`] = createHash("sha256")
        .update(body)
        .digest("hex");
      await writeJSON(join(syntheticRoot, "manifest.json"), synthetic);
      await writeJSON(
        join(evidence, "synthetic-test-only-manifest.json"),
        synthetic,
      );
      await cliCommand("check-bundle", [], {}, syntheticRoot);
      await cliCommand(
        "upgrade",
        [],
        { expectedFailure: true, label: "upgrade-requires-migration-opt-in" },
        syntheticRoot,
      );
      assert.equal(
        await readlink(join(prefix, "current")),
        `releases/${manifest.release}`,
      );
      await verify();
      await cliCommand(
        "upgrade",
        ["--apply-migrations"],
        { timeout: 660000 },
        syntheticRoot,
      );
      assert.equal(
        await readlink(join(prefix, "current")),
        `releases/${syntheticRelease}`,
      );
      assert.equal(
        (
          await query(
            "SELECT label FROM installable_acceptance_sentinel WHERE id=1",
            "upgrade-sentinel",
          )
        ).stdout.trim(),
        "TEST_ONLY_PRESERVE_ON_APPLICATION_ROLLBACK",
      );
      return {
        syntheticRelease,
        representsProductRelease: false,
        addedMigrations: 1,
        missingMigrationOptInRejected: true,
      };
    });
    await phase("application-rollback-retains-schema", async () => {
      await cliCommand("rollback");
      assert.equal(
        await readlink(join(prefix, "current")),
        `releases/${manifest.release}`,
      );
      assert.equal(
        (
          await query(
            "SELECT label FROM installable_acceptance_sentinel WHERE id=1",
            "rollback-preserved-sentinel",
          )
        ).stdout.trim(),
        "TEST_ONLY_PRESERVE_ON_APPLICATION_ROLLBACK",
      );
      assert.equal(
        Number(
          (
            await query(
              "SELECT COUNT(*) FROM artfi_schema_migrations WHERE dirty=FALSE",
              "rollback-preserved-ledger",
            )
          ).stdout.trim(),
        ),
        manifest.migrations + 1,
      );
      const verified = await verify();
      return {
        restoredRelease: manifest.release,
        addedSchemaAndRowPreserved: true,
        downMigrationsExecuted: false,
        verification: verified.report,
      };
    });
    const units = join(evidence, "systemd-units");
    await phase("systemd-template-generation", async () => {
      await cliCommand("service-units", ["--output", units]);
      const files = (await readdir(units)).sort();
      assert.deepEqual(files, [
        "artfi-agent.service",
        "artfi-api.service",
        "artfi-mirror.service",
        "artfi-monitor.service",
        "artfi-web.service",
      ]);
      for (const file of files) {
        const body = await readFile(join(units, file), "utf8");
        assert.match(body, /ExecStart=:/);
        assert.doesNotMatch(
          body,
          /MYSQL_DSN|ARTFI_USER_SESSION_SECRET|OPENSEA_API_KEY|@(?:SERVICE|PREFIX|NODE|CLI)@/,
        );
      }
      return { generated: files, installedInServiceManager: false };
    });
    await phase("systemd-template-parser", async () => {
      const userRuntimeDirectory = join(evidence, "systemd-user-runtime");
      await mkdir(userRuntimeDirectory, { mode: 0o700 });
      const result = await command(
        options["systemd-analyze"] || "systemd-analyze",
        [
          "--user",
          "verify",
          "--man=no",
          ...(await readdir(units)).sort().map((name) => join(units, name)),
        ],
        {
          label: "systemd-analyze-verify",
          extraEnv: { XDG_RUNTIME_DIR: userRuntimeDirectory },
        },
      );
      return {
        parserLog: result.log,
        parserMode: "user",
        privateRuntimeDirectory: true,
        installedInServiceManager: false,
      };
    });
    await stop();
    await phase("migration-checksum-guard", async () => {
      const changedMigrations = join(evidence, "changed-checksum-test-only");
      await cp(join(bundle, "migrations"), changedMigrations, {
        recursive: true,
      });
      const first = (await readdir(changedMigrations))
        .filter((name) => name.endsWith(".up.sql"))
        .sort()[0];
      await writeFile(
        join(changedMigrations, first),
        `${await readFile(join(changedMigrations, first), "utf8")}\n-- TEST_ONLY changed checksum\n`,
      );
      const output = await command(
        join(bundle, "runtime/bin/artfi-migrate"),
        ["-directory", changedMigrations, "-action", "status"],
        {
          label: "checksum-guard",
          expectedFailure: true,
          extraEnv: { MYSQL_DSN: dsn },
        },
      );
      assert.match(output.stderr, /checksum changed/);
      return { changedMigrationRejected: true };
    });
    await phase("migration-dirty-ledger-guard", async () => {
      await query(
        `UPDATE artfi_schema_migrations SET dirty=TRUE WHERE name='${syntheticMigration}'`,
        "test-only-dirty-ledger",
      );
      try {
        const output = await command(
          join(bundle, "runtime/bin/artfi-migrate"),
          ["-directory", join(bundle, "migrations"), "-action", "status"],
          {
            label: "dirty-ledger-guard",
            expectedFailure: true,
            extraEnv: { MYSQL_DSN: dsn },
          },
        );
        assert.match(output.stderr, /incomplete migration/);
      } finally {
        await query(
          `UPDATE artfi_schema_migrations SET dirty=FALSE WHERE name='${syntheticMigration}'`,
          "restore-test-only-ledger",
        );
      }
      return { dirtyLedgerRejected: true, testFixtureRestored: true };
    });
    await phase("final-artifact-integrity", async () => {
      assert.equal(await fileHash(artifact), report.artifact.sha256);
      assert.equal(
        await fileHash(join(bundle, "manifest.json")),
        report.artifact.manifestSha256,
      );
      await cliCommand("check-bundle");
      const installed = join(prefix, "releases", manifest.release);
      await cliCommand("check-bundle", [], {}, installed);
      await start();
      await verify();
      return {
        archiveUnchanged: true,
        extractedAndInstalledFilesVerified: true,
      };
    });
    await phase("managed-process-stop", async () => {
      await stop();
      await stoppedRecords();
      for (const url of [
        `${webURL}/api/health`,
        `${apiURL}/healthz`,
        `${agentURL}/healthz`,
      ])
        await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
      return { apiWebAgentStopped: true, managedPIDRecordsRemoved: true };
    });
  } catch (error) {
    report.failure = String(error.message);
    console.error(`Acceptance stopped: ${error.message}`);
  } finally {
    const cleanup = {
      servicesStopped: !servicesMayRun,
      mysqlStopped: !mysqlProcess,
    };
    if (servicesMayRun && node && cli) {
      try {
        await stop();
        cleanup.servicesStopped = true;
      } catch (error) {
        cleanup.serviceError = error.message;
      }
    }
    if (mysqlProcess) {
      if (mysqlProcess.exitCode === null && mysqlProcess.signalCode === null) {
        mysqlProcess.kill("SIGTERM");
        for (
          let i = 0;
          i < 100 &&
          mysqlProcess.exitCode === null &&
          mysqlProcess.signalCode === null;
          i++
        )
          await sleep(100);
      }
      cleanup.mysqlStopped =
        mysqlProcess.exitCode !== null || mysqlProcess.signalCode !== null;
      if (!cleanup.mysqlStopped) {
        mysqlProcess.kill("SIGKILL");
        cleanup.mysqlForcedStop = true;
      }
    }
    await mysqlLog?.close();
    report.cleanup = cleanup;
    report.finishedAt = new Date().toISOString();
    if (!cleanup.servicesStopped || !cleanup.mysqlStopped)
      report.checks.push({
        name: "cleanup",
        result: "FAILED",
        required: true,
        reason:
          "A managed test process did not stop normally; inspect private evidence.",
      });
    await save();
  }
  console.log(
    JSON.stringify(
      {
        result: report.result,
        artifact: report.artifact,
        evidenceDirectory: evidence,
        report: join(evidence, "report.json"),
      },
      null,
      2,
    ),
  );
  return report;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(help);
    else if ((await runAcceptance(options)).result !== "PASSED")
      process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
