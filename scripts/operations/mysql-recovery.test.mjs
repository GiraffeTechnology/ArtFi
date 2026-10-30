import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseArguments,
  requirePrivateFile,
  restore,
  status,
  verify,
} from "./mysql-recovery.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const base = [
  "backup",
  "--defaults-file",
  "/private/client.cnf",
  "--database",
  "artfi",
  "--output",
  "/private/new",
];

test("explicit options reject secrets, SQL identifiers, unknown and repeated arguments", () => {
  assert.equal(parseArguments(base).options.database, "artfi");
  for (const args of [
    [...base, "--password", "sensitive"],
    [...base, "--user", "root"],
    [...base, "--database", "other"],
    ["backup"],
    ["drop"],
    [...base.slice(0, 4), "artfi;DROP_DATABASE", ...base.slice(5)],
    [...base, "--lock-timeout", "301"],
    [...base, "--timeout-seconds", "0"],
  ])
    assert.throws(() => parseArguments(args));
  assert.equal(
    parseArguments([...base, "--lock-timeout", "0"]).options["lock-timeout"],
    "0",
  );
  assert.throws(
    () =>
      parseArguments([
        "restore",
        "--defaults-file",
        "/private/client.cnf",
        "--database",
        "artfi",
        "--backup",
        "/private/backup",
      ]),
    /trusted-backup/,
  );
});

test("configuration is an absolute owned private regular file, never a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artfi-mysql-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "client.cnf");
  await writeFile(file, "[client]\nuser=TEST_ONLY\n", { mode: 0o600 });
  await requirePrivateFile(file);
  await assert.rejects(requirePrivateFile("relative.cnf"), /absolute/);
  await chmod(file, 0o644);
  await assert.rejects(requirePrivateFile(file), /0600/);
  await chmod(file, 0o600);
  await symlink(file, join(root, "linked.cnf"));
  await assert.rejects(requirePrivateFile(join(root, "linked.cnf")), /0600/);
});

test("verification checks completion, private modes, file name, SHA-256, size and schema digest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artfi-mysql-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sql = "CREATE TABLE fixture (id INT PRIMARY KEY) ENGINE=InnoDB;\n";
  const schema = { database: [], tables: [{ name: "fixture" }] };
  const manifest = {
    format: "artfi-mysql-backup-v1",
    completed: true,
    file: "database.sql",
    sha256: digest(sql),
    bytes: Buffer.byteLength(sql),
    schema,
    schemaSha256: digest(JSON.stringify(schema)),
    ledger: [{ name: "TEST_ONLY" }],
  };
  await writeFile(join(root, "database.sql"), sql, { mode: 0o600 });
  const save = (value) =>
    writeFile(join(root, "manifest.json"), JSON.stringify(value), {
      mode: 0o600,
    });
  await save(manifest);
  assert.equal((await verify({ backup: root })).result, "PASSED");
  assert.equal((await verify({ backup: root })).authenticityVerified, false);
  for (const value of [
    { ...manifest, completed: false },
    { ...manifest, file: "../private.sql" },
    { ...manifest, bytes: manifest.bytes + 1 },
    { ...manifest, sha256: "0".repeat(64) },
    { ...manifest, schemaSha256: "0".repeat(64) },
  ]) {
    await save(value);
    await assert.rejects(verify({ backup: root }));
  }
  await save(manifest);
  await chmod(root, 0o755);
  await assert.rejects(verify({ backup: root }), /0700/);
  await chmod(root, 0o700);
  await chmod(join(root, "database.sql"), 0o644);
  await assert.rejects(verify({ backup: root }), /0600/);
});

test("restore refuses a backup before any database connection unless trust is explicit", async () => {
  await assert.rejects(
    restore({ backup: "/missing", database: "unused" }),
    /trusted-backup/,
  );
});

test("client errors do not disclose stderr, credentials or private values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artfi-mysql-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "client.cnf");
  await writeFile(config, "[client]\nuser=TEST_ONLY\n", { mode: 0o600 });
  const fake = join(root, "fake-mysql");
  await writeFile(
    fake,
    "#!/bin/sh\nprintf 'TEST_ONLY_SECRET_MUST_NOT_LEAK' >&2\nexit 1\n",
    { mode: 0o700 },
  );
  await assert.rejects(
    status({ "defaults-file": config, database: "test_only", mysql: fake }),
    (error) => {
      assert.doesNotMatch(error.message, /TEST_ONLY_SECRET/);
      assert.match(error.message, /MySQL/);
      return true;
    },
  );
});
