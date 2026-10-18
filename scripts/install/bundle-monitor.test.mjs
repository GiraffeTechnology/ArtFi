import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { bundleMonitor, monitorFiles } from "./bundle-monitor.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-monitor-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source"),
    destination = join(directory, "payload");
  await mkdir(join(root, "scripts/ops"), { recursive: true });
  for (const name of monitorFiles)
    await writeFile(join(root, "scripts/ops", name), "TEST_ONLY_" + name);
  return { directory, root, destination };
}

test("monitor package copies exactly the fixed production files with full-byte readback", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "private.json",
    "monitor-state.json",
    ".env",
    "monitor-core.test.mjs",
    "untracked.mjs",
  ])
    await writeFile(
      join(f.root, "scripts/ops", name),
      "SYNTHETIC_EXCLUDED_PRIVATE_MARKER",
    );
  await mkdir(join(f.root, "scripts/ops/fixtures"));
  await writeFile(
    join(f.root, "scripts/ops/fixtures/crash-worker.mjs"),
    "SYNTHETIC_EXCLUDED_FIXTURE",
  );
  const rows = await bundleMonitor(f.root, f.destination);
  assert.deepEqual(
    (await readdir(f.destination)).sort(),
    [...monitorFiles].sort(),
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    [...monitorFiles],
  );
  for (const row of rows) {
    const source = await readFile(join(f.root, "scripts/ops", row.name));
    const bytes = await readFile(join(f.destination, row.name));
    assert.deepEqual(bytes, source);
    assert.equal(row.bytes, bytes.length);
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
    const mode = (await lstat(join(f.destination, row.name))).mode;
    assert.ok(mode & 0o400);
    assert.equal(mode & 0o133, 0);
  }
});

test("monitor package refuses a missing required module before creating output", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "scripts/ops/host-capacity.mjs"));
  await assert.rejects(bundleMonitor(f.root, f.destination));
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("monitor package refuses symlinked production files without following private content", async (t) => {
  const f = await fixture(t),
    outside = join(f.directory, "private-file");
  await writeFile(outside, "SYNTHETIC_PRIVATE_FILE");
  const file = join(f.root, "scripts/ops/monitor-core.mjs");
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(bundleMonitor(f.root, f.destination), /SOURCE_REFUSED/);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "SYNTHETIC_PRIVATE_FILE");
});

test("monitor package refuses a symlinked source directory", async (t) => {
  const f = await fixture(t),
    linked = join(f.directory, "linked-source");
  await mkdir(join(linked, "scripts"), { recursive: true });
  await symlink(join(f.root, "scripts/ops"), join(linked, "scripts/ops"));
  await assert.rejects(bundleMonitor(linked, f.destination), /SOURCE_REFUSED/);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("monitor package never overwrites an existing destination", async (t) => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(join(f.destination, "owned-sentinel"), "PRESERVE");
  await assert.rejects(bundleMonitor(f.root, f.destination));
  assert.deepEqual(await readdir(f.destination), ["owned-sentinel"]);
  assert.equal(
    await readFile(join(f.destination, "owned-sentinel"), "utf8"),
    "PRESERVE",
  );
});

test("monitor package refuses output inside its source tree", async (t) => {
  const f = await fixture(t);
  for (const name of ["payload", "..payload"]) {
    await assert.rejects(
      bundleMonitor(f.root, join(f.root, "scripts/ops", name)),
      /SOURCE_REFUSED/,
    );
    await assert.rejects(lstat(join(f.root, "scripts/ops", name)), {
      code: "ENOENT",
    });
  }
  const alias = join(f.directory, "source-alias");
  await symlink(join(f.root, "scripts/ops"), alias);
  await assert.rejects(
    bundleMonitor(f.root, join(alias, "payload")),
    /SOURCE_REFUSED/,
  );
});

test("monitor package imports the actual copied production dependency graph without starting it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "artfi-monitor-realgraph-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  await mkdir(join(directory, "tools/operations"), { recursive: true });
  await cp(
    join(root, "scripts/operations/mysql-recovery.mjs"),
    join(directory, "tools/operations/mysql-recovery.mjs"),
  );
  await bundleMonitor(root, join(directory, "tools/ops"));
  const service = await import(
    pathToFileURL(join(directory, "tools/ops/monitor-service.mjs"))
  );
  const status = await import(
    pathToFileURL(join(directory, "tools/ops/monitor-status.mjs"))
  );
  assert.equal(typeof service.runService, "function");
  assert.equal(typeof service.serviceProbe, "function");
  assert.ok(Object.keys(status).length > 0);
});
