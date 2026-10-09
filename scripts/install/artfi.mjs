#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessIdentity, isSameProcess } from "./process-info.mjs";
import { configure, validate } from "./config.mjs";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2),
  command = args.shift() || "help",
  options = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith("--")) throw new Error("Use named --options.");
  const key = args[i].slice(2);
  options[key] =
    args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
}
const prefix = resolve(
  options.prefix ||
    join(process.env.HOME || process.cwd(), ".local/share/artfi"),
);
const shared = join(prefix, "shared"),
  configPath = resolve(options.config || join(shared, "config.json"));
if (/[\x00-\x1f\x7f]/.test(prefix) || /[\x00-\x1f\x7f]/.test(configPath))
  throw new Error(
    "Installation and configuration paths must not contain control characters.",
  );
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
function isWithin(parent, child) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
async function realDestination(destination) {
  let ancestor = resolve(destination);
  const remaining = [];
  while (!(await exists(ancestor))) {
    remaining.unshift(basename(ancestor));
    const next = dirname(ancestor);
    if (next === ancestor)
      throw new Error("The destination has no existing parent.");
    ancestor = next;
  }
  return resolve(await realpath(ancestor), ...remaining);
}
async function outsideBundle(destination) {
  return !isWithin(await realpath(ownRoot), await realDestination(destination));
}

const writeJSON = async (path, data, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
};
async function config() {
  const value = await json(configPath),
    result = validate(value);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  return value;
}
async function releaseRoot() {
  if (options.release) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(options.release))
      throw new Error("Invalid release identifier.");
    return join(prefix, "releases", options.release);
  }
  try {
    return resolve(prefix, await readlink(join(prefix, "current")));
  } catch {
    throw new Error("No active release. Use install first.");
  }
}
async function checkedRoot(root) {
  const m = await json(join(root, "manifest.json"));
  if (
    m.format !== 1 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(m.release) ||
    !m.files ||
    typeof m.files !== "object"
  )
    throw new Error("Invalid release manifest.");
  for (const [name, expected] of Object.entries(m.files)) {
    if (
      name.includes("\\") ||
      isAbsolute(name) ||
      name.split("/").some((part) => ["..", "."].includes(part))
    )
      throw new Error("Unsafe manifest path.");
    const file = join(root, name);
    if (!isWithin(root, await realpath(file)) || !(await lstat(file)).isFile())
      throw new Error(`Unexpected link or non-file: ${name}`);
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (digest !== expected)
      throw new Error(`Release checksum mismatch: ${name}`);
  }
  for (const [name, target] of Object.entries(m.links || {})) {
    if (
      isAbsolute(name) ||
      name.split("/").includes("..") ||
      name.includes("\\")
    )
      throw new Error("Unsafe link manifest path.");
    const file = join(root, name);
    if (
      !(await lstat(file)).isSymbolicLink() ||
      (await readlink(file)) !== target ||
      !isWithin(root, await realpath(file))
    )
      throw new Error(`Unsafe or changed release link: ${name}`);
  }
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name),
        name = relative(root, file);
      if (name === "manifest.json") continue;
      if (
        name === "runtime/web/apps/web/.next/cache" &&
        root.startsWith(join(prefix, "releases") + "/") &&
        entry.isSymbolicLink() &&
        (await readlink(file)) === join(shared, "cache", m.release)
      )
        continue;
      if (entry.isDirectory()) await scan(file);
      else if (
        !Object.hasOwn(m.files, name) &&
        !Object.hasOwn(m.links || {}, name)
      )
        throw new Error(`Unlisted release file: ${name}`);
    }
  }
  await scan(root);
  return m;
}
async function serviceEnv(root) {
  const value = await config(),
    manifest = await json(join(root, "manifest.json"));
  for (const feature of ["AGENT", "MONITOR"]) {
    if (value[`ARTFI_${feature}_ENABLED`] !== "true") continue;
    const path = value[`ARTFI_${feature}_CONFIG_FILE`];
    if (!(await outsideBundle(path)))
      throw new Error(
        `${feature} configuration must stay outside the distributable artifact.`,
      );
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error(
        `${feature} configuration must be a private regular file.`,
      );
  }
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || shared,
    TMPDIR: process.env.TMPDIR || "/tmp",
    ...value,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ARTFI_BUILD_SHA: manifest.source.revision,
    ARTFI_SOURCE_FINGERPRINT: manifest.source.fingerprint,
    OPENSEA_STREAM_STORAGE_PATH: join(shared, "mirror", "stream"),
    OPENSEA_BACKFILL_STATE_DIRECTORY: join(shared, "mirror", "backfill"),
  };
}
function serviceSpec(root, name, env = {}) {
  if (name === "api") return [join(root, "runtime/bin/artfi-api"), []];
  if (name === "web")
    return [
      join(root, "runtime/bin/node"),
      [join(root, "runtime/web/apps/web/server.js")],
    ];
  if (name === "mirror")
    return [
      join(root, "runtime/bin/node"),
      [join(root, "runtime/mirror/dist/index.js")],
    ];
  if (name === "agent")
    return [
      join(root, "runtime/bin/node"),
      [join(root, "runtime/agent/src/server.mjs")],
    ];
  if (name === "monitor")
    return [
      join(root, "runtime/bin/node"),
      [
        join(root, "tools/operations/monitor.mjs"),
        env.ARTFI_MONITOR_CONFIG_FILE,
        "--watch",
      ],
    ];
  throw new Error("Service must be api, web, mirror, agent or monitor.");
}
async function migrate(root, action) {
  const env = await serviceEnv(root);
  if (!env.MYSQL_DSN)
    return {
      databaseConnected: false,
      pending: null,
      notRun: "MYSQL_DSN is not configured",
    };
  const result = spawnSync(
    join(root, "runtime/bin/artfi-migrate"),
    ["-directory", join(root, "migrations"), "-action", action],
    { env, encoding: "utf8", timeout: 660000 },
  );
  if (result.status !== 0)
    throw new Error((result.stderr || "Migration process failed.").trim());
  return JSON.parse(result.stdout);
}
async function switchRelease(root) {
  const manifest = await checkedRoot(root),
    previous = (await exists(join(prefix, "current")))
      ? await readlink(join(prefix, "current"))
      : null;
  const target = relative(prefix, root);
  if (previous === target) return manifest;
  if (target.startsWith("..") || !target.startsWith("releases/"))
    throw new Error("Release must belong to this installation.");
  const temporary = join(prefix, `current.${process.pid}.tmp`);
  await symlink(target, temporary);
  await rename(temporary, join(prefix, "current"));
  await writeJSON(join(shared, "activation.json"), {
    active: manifest.release,
    previous: previous ? previous.split("/").at(-1) : null,
    activatedAt: new Date().toISOString(),
  });
  return manifest;
}
async function install() {
  if (!(await outsideBundle(prefix)))
    throw new Error(
      "Choose an installation prefix outside the extracted release bundle.",
    );
  const manifest = await checkedRoot(ownRoot),
    cfg = await config();
  const root = join(prefix, "releases", manifest.release);
  if (await exists(root)) await checkedRoot(root);
  else {
    await mkdir(join(prefix, "releases"), { recursive: true });
    const temporary = `${root}.installing-${process.pid}`;
    try {
      await cp(ownRoot, temporary, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
      await checkedRoot(temporary);
      await rename(temporary, root);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  for (const path of [
    "logs",
    "run",
    "mirror/stream",
    "mirror/backfill",
    `cache/${manifest.release}`,
  ])
    await mkdir(join(shared, path), { recursive: true, mode: 0o700 });
  const cache = join(root, "runtime/web/apps/web/.next/cache");
  if (!(await exists(cache)))
    await symlink(join(shared, "cache", manifest.release), cache);
  await writeJSON(join(shared, "staged.json"), {
    release: manifest.release,
    stagedAt: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      installed: manifest.release,
      activated: false,
      configurationWarnings: validate(cfg).warnings,
    }),
  );
  return root;
}
const processAlive = isSameProcess;
async function start(root) {
  const env = await serviceEnv(root),
    names = [
      "api",
      "web",
      ...(env.ARTFI_MIRROR_ENABLED === "true" ? ["mirror"] : []),
      ...(env.ARTFI_AGENT_ENABLED === "true" ? ["agent"] : []),
      ...(env.ARTFI_MONITOR_ENABLED === "true" ? ["monitor"] : []),
    ];
  for (const name of names) {
    const pidfile = join(shared, "run", `${name}.json`);
    if ((await exists(pidfile)) && (await processAlive(await json(pidfile))))
      throw new Error(
        `${name} is already running; stop before switching releases.`,
      );
  }
  for (const name of names) {
    const [exe, argv] = serviceSpec(root, name, env),
      log = await open(join(shared, "logs", `${name}.log`), "a", 0o600);
    const child = spawn(exe, argv, {
      env,
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise((accept, reject) => {
      child.once("spawn", accept);
      child.once("error", reject);
    });
    await writeJSON(join(shared, "run", `${name}.json`), {
      pid: child.pid,
      ...(await readProcessIdentity(child.pid)),
      release: root,
    });
    child.unref();
    await log.close();
  }
  return names;
}
async function stop() {
  for (const name of ["monitor", "agent", "mirror", "web", "api"]) {
    const path = join(shared, "run", `${name}.json`);
    if (!(await exists(path))) continue;
    const record = await json(path);
    if (await processAlive(record)) {
      process.kill(record.pid, "SIGTERM");
      for (let i = 0; i < 300 && (await processAlive(record)); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (await processAlive(record))
        throw new Error(`${name} did not stop; inspect it before retrying.`);
    }
    await rm(path, { force: true });
  }
}
async function verify(root) {
  const cfg = await config(),
    checks = [];
  const webHost = ["0.0.0.0", "::", "[::]"].includes(cfg.HOSTNAME)
    ? "127.0.0.1"
    : cfg.HOSTNAME;
  const web =
    options["web-url"] ||
    `http://${webHost.includes(":") && !webHost.startsWith("[") ? `[${webHost}]` : webHost}:${cfg.PORT}`;
  const api = options["api-url"] || cfg.ARTFI_API_URL;
  for (const [name, url, accept] of [
    [
      "api-health",
      `${api.replace(/\/$/, "")}/healthz`,
      (body) => JSON.parse(body).service === "artfi-api",
    ],
    [
      "web-health",
      `${web}/api/health`,
      (body) => JSON.parse(body).service === "artfi-web",
    ],
    [
      "three-section-page",
      `${web}/`,
      (body) => body.includes("artfi-public-config"),
    ],
    [
      "same-origin-public-api",
      `${web}/v1/config`,
      (body) => JSON.parse(body).api === "v1",
    ],
    [
      "native-nft-surface",
      `${web}/nft`,
      (body) => body.includes("artfi-public-config"),
    ],
  ]) {
    let ok = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(3000),
        });
        ok = response.ok && accept(await response.text());
        if (ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    checks.push({ name, result: ok ? "PASSED" : "FAILED" });
  }
  try {
    const result = await migrate(root, "status");
    checks.push({
      name: "database-migrations",
      result: result.notRun
        ? "NOT_RUN"
        : result.pending === 0
          ? "PASSED"
          : "FAILED",
      ...(result.notRun
        ? { reason: result.notRun }
        : { count: result.migrations.length }),
    });
  } catch {
    checks.push({
      name: "database-migrations",
      result: "FAILED",
      reason:
        "Database or migration verification failed; inspect configuration securely.",
    });
  }
  if (cfg.MYSQL_DSN) {
    try {
      const response = await fetch(`${api.replace(/\/$/, "")}/readyz`, {
        signal: AbortSignal.timeout(3000),
      });
      checks.push({
        name: "api-primary-readiness",
        result:
          response.ok && (await response.json()).status === "ready"
            ? "PASSED"
            : "FAILED",
      });
    } catch {
      checks.push({ name: "api-primary-readiness", result: "FAILED" });
    }
    try {
      const response = await fetch(
        `${api.replace(/\/$/, "")}/v1/orders?kind=fraction`,
        { signal: AbortSignal.timeout(5000) },
      );
      checks.push({
        name: "persistent-orders-read",
        result: response.ok ? "PASSED" : "FAILED",
      });
    } catch {
      checks.push({ name: "persistent-orders-read", result: "FAILED" });
    }
  }
  checks.push({
    name: "external-chain-and-venue-transactions",
    result: "NOT_RUN",
    reason:
      "Installation verification never signs, submits or cancels real-value operations.",
  });
  const output = {
    release: (await json(join(root, "manifest.json"))).release,
    checkedAt: new Date().toISOString(),
    checks,
  };
  await writeJSON(join(shared, "verification.json"), output);
  console.log(JSON.stringify(output, null, 2));
  return (
    !checks.some((check) => check.result === "FAILED") &&
    !(
      options["require-database"] &&
      checks.some(
        (check) =>
          check.name === "database-migrations" && check.result !== "PASSED",
      )
    )
  );
}
async function main() {
  if (command === "help") {
    console.log(
      "ArtFi install utility\nconfigure --prefix DIR [--input settings.json]\nvalidate --prefix DIR\ncheck-bundle\ninstall --prefix DIR\nmigrate --prefix DIR --release RELEASE\nactivate --prefix DIR --release RELEASE\nstart|stop|verify --prefix DIR\nupgrade --prefix DIR [--apply-migrations]\nrollback --prefix DIR\nservice-units --prefix DIR --output DIR\nrun --prefix DIR --service api|web|mirror|agent|monitor\nUse the packaged runtime/bin/node; no npm, Go, Docker or source checkout is required.",
    );
    return;
  }
  if (command === "configure") {
    if (!(await outsideBundle(configPath)))
      throw new Error(
        "Keep private configuration outside the extracted bundle or source checkout.",
      );
    const previous = (await exists(configPath)) ? await json(configPath) : {};
    const input = options.input ? await json(resolve(options.input)) : {};
    const value = configure(input, previous),
      result = validate(value);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    await writeJSON(configPath, value);
    console.log(
      JSON.stringify({
        configured: true,
        secretValuesPrinted: false,
        warnings: result.warnings,
      }),
    );
    return;
  }
  if (command === "validate") {
    const result = validate(await json(configPath));
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
    return;
  }
  if (command === "check-bundle") {
    const manifest = await checkedRoot(ownRoot);
    console.log(
      JSON.stringify({
        verified: true,
        release: manifest.release,
        files: Object.keys(manifest.files).length,
      }),
    );
    return;
  }
  if (command === "install") {
    await install();
    return;
  }
  if (command === "stop") {
    await stop();
    console.log("Services stopped.");
    return;
  }
  if (command === "upgrade") {
    const root = await install(),
      state = await migrate(root, "status");
    if (state.pending > 0 && !options["apply-migrations"])
      throw new Error(
        "Forward migrations are pending. Back up the database and rerun with --apply-migrations.",
      );
    let old;
    try {
      old = await releaseRoot();
    } catch {}
    await stop();
    try {
      if (state.pending > 0) await migrate(root, "up");
      await switchRelease(root);
      await start(root);
      if (!(await verify(root)))
        throw new Error("Post-upgrade verification failed.");
    } catch (error) {
      await stop();
      if (old) {
        await switchRelease(old);
        await start(old);
        console.error(
          "Previous application release restarted; schema was retained. Verify the previous release.",
        );
      }
      throw error;
    }
    return;
  }
  if (command === "rollback") {
    const state = await json(join(shared, "activation.json"));
    if (!state.previous) throw new Error("No previous release is recorded.");
    const root = join(prefix, "releases", state.previous);
    await checkedRoot(root);
    const db = await migrate(root, "status");
    if (db.pending > 0)
      throw new Error(
        "The rollback release requires migrations missing from this database.",
      );
    await stop();
    await switchRelease(root);
    await start(root);
    if (!(await verify(root))) process.exitCode = 1;
    return;
  }
  const root = await releaseRoot();
  if (command === "migrate") {
    console.log(JSON.stringify(await migrate(root, "up"), null, 2));
    return;
  }
  if (command === "activate") {
    for (const name of ["api", "web", "mirror", "agent", "monitor"]) {
      const file = join(shared, "run", `${name}.json`);
      if ((await exists(file)) && (await processAlive(await json(file))))
        throw new Error(
          "Stop managed services before changing the active release.",
        );
    }
    const state = await migrate(root, "status");
    if (state.pending > 0)
      throw new Error("Apply pending migrations before activation.");
    const manifest = await switchRelease(root);
    console.log(JSON.stringify({ activated: manifest.release }));
    return;
  }
  if (command === "start") {
    console.log(JSON.stringify({ started: await start(root) }));
    return;
  }
  if (command === "verify") {
    if (!(await verify(root))) process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const name = options.service,
      env = await serviceEnv(root);
    if (name === "mirror" && env.ARTFI_MIRROR_ENABLED !== "true")
      throw new Error("Market mirror is disabled.");
    if (name === "agent" && env.ARTFI_AGENT_ENABLED !== "true")
      throw new Error("Agent runtime is disabled.");
    if (name === "monitor" && env.ARTFI_MONITOR_ENABLED !== "true")
      throw new Error("Operations monitor is disabled.");
    const [exe, argv] = serviceSpec(root, name, env);
    const child = spawn(exe, argv, { env, cwd: root, stdio: "inherit" });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      console.error("Service could not start.");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (command === "service-units") {
    if (/["'\\]/.test(prefix))
      throw new Error(
        "systemd units require an installation path without quotes or backslashes; native CLI lifecycle remains supported.",
      );
    const output = resolve(options.output || join(shared, "systemd"));
    await mkdir(output, { recursive: true });
    const esc = (value) =>
      `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
    for (const name of ["api", "web", "mirror", "agent", "monitor"]) {
      let template = await readFile(
        join(root, "tools/install/templates/artfi.service.in"),
        "utf8",
      );
      template = template
        .replaceAll("@SERVICE@", name)
        // WorkingDirectory is a single path, not an ExecStart argument list.
        // The harmless /. suffix preserves terminal spaces/backslashes without
        // an INI line continuation or trailing-whitespace trim.
        .replaceAll("@WORKING_DIRECTORY@", `${prefix.replaceAll("%", "%%")}/.`)
        .replaceAll("@PREFIX@", esc(prefix))
        .replaceAll("@NODE@", esc(join(prefix, "current/runtime/bin/node")))
        .replaceAll(
          "@CLI@",
          esc(join(prefix, "current/tools/install/artfi.mjs")),
        );
      await writeFile(join(output, `artfi-${name}.service`), template, {
        mode: 0o644,
      });
    }
    console.log(
      "Service unit files generated. Review them and enable the desired units with your service manager.",
    );
    return;
  }
  throw new Error("Unknown command. Use help.");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
