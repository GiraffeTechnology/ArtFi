import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeBackup, verify } from "../operations/mysql-recovery.mjs";
import {
  backupIntegrityProbe,
  validateBackupIntegrity,
} from "./backup-integrity.mjs";
import { Monitor, evaluate } from "./monitor-core.mjs";
import { serviceProbe, validateConfig } from "./monitor-service.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const clock = 2000000;
async function fixture(t, createdAt = new Date(clock - 100).toISOString()) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-backup-observation-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sql =
    "-- TEST_ONLY_SECRET_SQL\nCREATE TABLE fixture (id INT PRIMARY KEY) ENGINE=InnoDB;\n";
  const schema = { database: [], tables: [{ name: "fixture" }] };
  const manifest = {
    format: "artfi-mysql-backup-v1",
    completed: true,
    createdAt,
    sourceDatabase: "TEST_ONLY_SOURCE_DATABASE",
    file: "database.sql",
    sha256: hash(sql),
    bytes: Buffer.byteLength(sql),
    schema,
    schemaSha256: hash(JSON.stringify(schema)),
    ledger: [{ name: "TEST_ONLY" }],
  };
  await writeFile(join(directory, "database.sql"), sql, { mode: 0o600 });
  const save = (value = manifest) =>
    writeFile(join(directory, "manifest.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  await save();
  const check = {
    id: "backup-integrity",
    kind: "backup-integrity",
    category: "backup",
    maxAgeMs: 10000,
    backupDirectory: directory,
    maxBackupAgeMs: 1000,
  };
  return { directory, sql, manifest, save, check };
}
const probe = (f, now = () => clock) =>
  backupIntegrityProbe([f.check], { now })(f.check.id);
const config = (checks) => ({
  schemaVersion: 1,
  enabled: true,
  inventoryVerified: true,
  mode: "monitor-only",
  hostRole: "ctyun-abcdyi",
  environment: "test",
  stateDirectory: "/controlled/state",
  stopFile: "/controlled/state/STOP",
  intervalMs: 1000,
  checks,
});

test("backup observation reuses actual file checks without authenticity or restore claims", async (t) => {
  const f = await fixture(t);
  const paths = [
    join(f.directory, "database.sql"),
    join(f.directory, "manifest.json"),
  ];
  const before = await Promise.all(paths.map((p) => readFile(p)));
  assert.deepEqual(await observeBackup({ backup: f.directory }), {
    integrityVerified: true,
    createdAt: f.manifest.createdAt,
    authenticityVerified: false,
    restoreVerified: false,
  });
  assert.equal(
    (await verify({ backup: f.directory })).authenticityVerified,
    false,
  );
  assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), before);
});
test("backup probe emits only a sanitized fresh-artifact sample", async (t) => {
  const f = await fixture(t);
  validateConfig(config([f.check]));
  const sample = await probe(f);
  assert.deepEqual(sample, { available: true, fresh: true, observedAt: clock });
  assert.equal(evaluate(sample, clock, f.check.maxAgeMs), "healthy");
  assert.doesNotMatch(
    JSON.stringify(sample),
    /SQL|SOURCE_DATABASE|sha256|schema|backupDirectory/,
  );
});
test("backup age uses creation metadata even after file mtimes become recent", async (t) => {
  const f = await fixture(t, new Date(clock - 5000).toISOString());
  for (const name of ["database.sql", "manifest.json"])
    await utimes(join(f.directory, name), new Date(clock), new Date(clock));
  const sample = await probe(f);
  assert.deepEqual(sample, {
    available: true,
    fresh: false,
    observedAt: clock,
  });
  assert.equal(evaluate(sample, clock, f.check.maxAgeMs), "stale");
});
test("backup age boundary is inclusive and the next millisecond is stale", async (t) => {
  const f = await fixture(t, new Date(clock - 1000).toISOString());
  assert.equal((await probe(f)).fresh, true);
  await f.save({
    ...f.manifest,
    createdAt: new Date(clock - 1001).toISOString(),
  });
  assert.equal((await probe(f)).fresh, false);
});
test("backup checksum or private-mode failures never report healthy", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "database.sql"), f.sql + "CORRUPTION");
  assert.deepEqual(await probe(f), {
    available: false,
    fresh: false,
    observedAt: clock,
  });
  await writeFile(join(f.directory, "database.sql"), f.sql);
  await chmod(join(f.directory, "database.sql"), 0o644);
  assert.equal((await probe(f)).available, false);
  await chmod(join(f.directory, "database.sql"), 0o600);
  assert.equal((await probe(f)).available, true);
});
test("backup incomplete or mismatched manifests stay unavailable", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { completed: false },
    { file: "../outside.sql" },
    { bytes: f.manifest.bytes + 1 },
    { schemaSha256: "0".repeat(64) },
    { ledger: [] },
  ]) {
    await f.save({ ...f.manifest, ...change });
    assert.deepEqual(await probe(f), {
      available: false,
      fresh: false,
      observedAt: clock,
    });
  }
  await rm(join(f.directory, "manifest.json"));
  assert.equal((await probe(f)).available, false);
});
test("backup invalid or future creation times are distinct from integrity verification", async (t) => {
  const f = await fixture(t);
  for (const createdAt of [
    undefined,
    null,
    123,
    "invalid",
    "1970-01-01",
    new Date(clock + 1).toISOString(),
    "1970-01-01T00:33:20+00:00",
  ]) {
    await f.save({ ...f.manifest, createdAt });
    assert.equal((await verify({ backup: f.directory })).result, "PASSED");
    assert.deepEqual(await probe(f), {
      available: false,
      fresh: false,
      observedAt: clock,
    });
  }
});
test("backup probe requires explicit directory, age and backup-only identity", () => {
  const c = {
    id: "backup",
    kind: "backup-integrity",
    category: "backup",
    maxAgeMs: 10000,
    backupDirectory: "/controlled/backup",
    maxBackupAgeMs: 1000,
  };
  validateBackupIntegrity(c);
  for (const change of [
    { backupDirectory: undefined },
    { backupDirectory: "relative" },
    { backupDirectory: "/bad\npath" },
    { category: "db" },
    { maxBackupAgeMs: 0 },
    { maxBackupAgeMs: 999 },
    { maxBackupAgeMs: NaN },
    { maxBackupAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { url: "http://127.0.0.1/" },
    { trustedBackup: true },
  ])
    assert.throws(
      () => validateBackupIntegrity({ ...c, ...change }),
      /CONFIG_REFUSED/,
    );
  assert.throws(
    () => validateConfig(config([{ ...c, category: "db" }])),
    /CONFIG_REFUSED/,
  );
});
test("backup pre-abort refuses health without forwarding a private reason", async (t) => {
  const f = await fixture(t),
    control = new AbortController();
  control.abort(Error("SYNTHETIC_PRIVATE_ABORT_REASON"));
  await assert.rejects(
    backupIntegrityProbe([f.check], { now: () => clock })(
      f.check.id,
      control.signal,
    ),
    (error) => error.message === "BACKUP_OBSERVATION_ABORTED",
  );
  await assert.rejects(
    observeBackup({ backup: f.directory }, { signal: control.signal }),
    /interrupted/,
  );
});
test("backup in-flight native stream abort closes its read-only file handle", async (t) => {
  const f = await fixture(t),
    control = new AbortController();
  const file = await open(join(f.directory, "database.sql"), "r");
  const prototype = Object.getPrototypeOf(file),
    original = prototype.createReadStream;
  await file.close();
  let observedHandle,
    dataSeen = false;
  prototype.createReadStream = function (options) {
    const stream = original.call(this, options);
    if (options.signal === control.signal) {
      observedHandle = this;
      stream.once("data", () => {
        dataSeen = true;
        control.abort();
      });
    }
    return stream;
  };
  try {
    await assert.rejects(
      observeBackup({ backup: f.directory }, { signal: control.signal }),
    );
  } finally {
    prototype.createReadStream = original;
  }
  assert.equal(dataSeen, true);
  assert.ok(observedHandle);
  await assert.rejects(observedHandle.stat());
  assert.equal(
    await readFile(join(f.directory, "database.sql"), "utf8"),
    f.sql,
  );
});
test("backup unknown check and invalid clock are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    backupIntegrityProbe([f.check])("unknown"),
    /UNKNOWN_PROBE/,
  );
  for (const now of [NaN, -1, 1.5])
    await assert.rejects(
      probe(f, () => now),
      /CLOCK_REFUSED/,
    );
});
test("backup service routing stays independent of HTTP and host-capacity routes", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const checks = [
    f.check,
    {
      id: "host",
      kind: "host-capacity",
      category: "capacity",
      diskPath: "/controlled/disk",
      maxAgeMs: 10000,
    },
    {
      id: "web",
      kind: "liveness",
      category: "web",
      url: "http://127.0.0.1:12345/healthz",
      maxAgeMs: 10000,
    },
  ];
  validateConfig(config(checks));
  const adapter = serviceProbe(checks, {
    now: () => clock,
    disk: async () => ({ bavail: 50n, blocks: 100n, bsize: 4096n }),
    host: () => ({
      freeMemoryBytes: 500,
      totalMemoryBytes: 1000,
      loadPerCPU: 0.1,
    }),
    fetchImpl: async () => {
      calls++;
      return new Response("ignored");
    },
  });
  assert.equal((await adapter(f.check.id)).fresh, true);
  assert.equal((await adapter("host")).available, true);
  assert.equal(calls, 0);
  assert.equal((await adapter("web")).available, true);
  assert.equal(calls, 1);
});
test("backup integrity incidents persist and recover with their original identity", async (t) => {
  const f = await fixture(t);
  let now = clock;
  const directory = join(f.directory, "monitor-state");
  const create = () =>
    new Monitor({
      directory,
      environment: "test",
      checks: [f.check],
      threshold: 1,
      now: () => now,
      probe: backupIntegrityProbe([f.check], { now: () => now }),
    });
  await writeFile(
    join(f.directory, "database.sql"),
    "SYNTHETIC_CORRUPT_BACKUP",
  );
  const first = await create().tick();
  assert.equal(first.queue.length, 1);
  assert.equal(first.queue[0].type, "incident");
  assert.equal(first.queue[0].category, "backup");
  assert.equal(first.queue[0].status, "unavailable");
  assert.equal(
    JSON.parse(await readFile(join(directory, "monitor-state.json"), "utf8"))
      .queue[0].id,
    first.queue[0].id,
  );
  now += 1000;
  await writeFile(join(f.directory, "database.sql"), f.sql);
  await f.save({ ...f.manifest, createdAt: new Date(now).toISOString() });
  const second = await create().tick();
  assert.equal(second.queue.length, 2);
  assert.equal(second.queue[1].type, "recovery");
  assert.equal(second.queue[1].incidentId, first.queue[0].id);
  assert.equal(second.queue[1].status, "healthy");
  assert.doesNotMatch(
    JSON.stringify(second),
    /TEST_ONLY|database\.sql|sourceDatabase|schemaSha256|backupDirectory/,
  );
  assert.ok(!JSON.stringify(second).includes(f.directory));
});
test("backup probe snapshots directory and freshness threshold", async (t) => {
  const f = await fixture(t, new Date(clock - 2000).toISOString()),
    adapter = backupIntegrityProbe([f.check], { now: () => clock });
  f.check.backupDirectory = "/controlled/missing";
  f.check.maxBackupAgeMs = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await adapter("backup-integrity"), {
    available: true,
    fresh: false,
    observedAt: clock,
  });
});
