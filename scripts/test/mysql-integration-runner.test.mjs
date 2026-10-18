import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// TEST_ONLY shell orchestration fixture: Docker, SQL and Go are recorded, never
// executed. This proves runner selection/order/cleanup, not database acceptance.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fakeDocker = `
const fs = require('node:fs'), crypto = require('node:crypto');
const args = process.argv.slice(2), sql = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.TEST_ONLY_COMMAND_LOG, JSON.stringify({args, sqlHash:crypto.createHash('sha256').update(sql).digest('hex'), sql})+'\\n');
if (process.env.TEST_ONLY_FAIL_SQL && sql.includes(process.env.TEST_ONLY_FAIL_SQL)) process.exit(19);
if (args[0] === 'run' && process.env.TEST_ONLY_FAIL_GO === '1') process.exit(23);
if (sql.includes('COUNT(*)') || args.some((arg) => arg.includes('COUNT(*)'))) {
 const state = process.env.TEST_ONLY_SCHEMA_STATE;
 if (!fs.existsSync(state)) { fs.writeFileSync(state, 'checked'); console.log(process.env.TEST_ONLY_TABLE_COUNT || '51'); }
 else console.log('0');
}
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "artfi-mysql-runner-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts/test"), { recursive: true });
  await mkdir(join(root, "apps/api"), { recursive: true });
  await mkdir(join(root, "bin"));
  await cp(
    join(repository, "scripts/test/mysql-integration.sh"),
    join(root, "scripts/test/mysql-integration.sh"),
  );
  await cp(
    join(repository, "apps/api/migrations"),
    join(root, "apps/api/migrations"),
    { recursive: true },
  );
  const docker = join(root, "bin/docker");
  await writeFile(docker, `#!${process.execPath}\n${fakeDocker}`, {
    mode: 0o700,
  });
  await chmod(docker, 0o700);
  const log = join(root, "commands.jsonl");
  const run = (extra = {}) =>
    spawnSync("/bin/bash", [join(root, "scripts/test/mysql-integration.sh")], {
      cwd: root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HOME: root,
        LANG: "C.UTF-8",
        TEST_ONLY_COMMAND_LOG: log,
        TEST_ONLY_SCHEMA_STATE: join(root, "schema-state"),
        ...extra,
      },
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  const commands = async () => {
    try {
      return (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return { root, run, commands };
}
function cleanupScope(commands) {
  const compose = commands.filter((entry) => entry.args[0] === "compose");
  assert.ok(compose.length > 0);
  const project = compose[0].args[2];
  assert.match(project, /^artfi-mysql-test-[0-9]+$/);
  assert.ok(
    compose.every(
      (entry) => entry.args[1] === "-p" && entry.args[2] === project,
    ),
  );
  assert.deepEqual(compose.at(-1).args.slice(3), ["down", "-v"]);
  const drop = compose.find(
    (entry) =>
      entry.sql === "" &&
      entry.args.some((arg) =>
        /^DROP DATABASE IF EXISTS `artfi_codex_test_[0-9]+_[0-9]+`;$/.test(arg),
      ),
  );
  assert.ok(drop, "cleanup must drop only its generated isolated test DB");
}
test("MySQL runner applies all current migration bytes and rolls back in reverse order", async (t) => {
  const f = await fixture(t),
    result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const commands = await f.commands();
  const names = (await readdir(join(repository, "apps/api/migrations")))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  assert.equal(names.length, 17);
  const up = await Promise.all(
    names.map((name) =>
      readFile(join(repository, "apps/api/migrations", name), "utf8"),
    ),
  );
  const down = await Promise.all(
    names
      .toReversed()
      .map((name) =>
        readFile(
          join(
            repository,
            "apps/api/migrations",
            name.replace(".up.sql", ".down.sql"),
          ),
          "utf8",
        ),
      ),
  );
  assert.deepEqual(
    commands.filter((entry) => entry.sql !== "").map((entry) => entry.sqlHash),
    [...up, ...down].map(hash),
  );
  assert.equal(
    up.reduce(
      (count, sql) =>
        count +
        [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[a-z_]+/g)]
          .length,
      0,
    ),
    51,
  );
  const go = commands.find((entry) => entry.args[0] === "run");
  assert.ok(go.args.includes("ARTFI_NOTIFICATION_MYSQL_REQUIRED=1"));
  assert.ok(go.args.includes("ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED=1"));
  assert.ok(
    go.args.some((arg) =>
      /^ARTFI_INTEGRATION_MYSQL_DSN=root:local-root-only@tcp\(localhost:33306\)\/artfi_codex_test_[0-9]+_[0-9]+\?parseTime=true$/.test(
        arg,
      ),
    ),
  );
  assert.ok(go.args.includes("golang:1.26.5-bookworm"));
  assert.ok(go.args.includes("/usr/local/go/bin/go test -race -v ./..."));
  cleanupScope(commands);
});
test("MySQL runner refuses a missing late rollback before Docker commands", async (t) => {
  const f = await fixture(t);
  await rm(
    join(
      f.root,
      "apps/api/migrations/000017_whole_receipt_principal_observations.down.sql",
    ),
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing paired test migration/);
  assert.deepEqual(await f.commands(), []);
});
test("MySQL runner late migration failure prevents Go and still cleans only its project", async (t) => {
  const f = await fixture(t),
    result = f.run({
      TEST_ONLY_FAIL_SQL: "CREATE TABLE whole_receipt_principal_observations",
    });
  assert.equal(result.status, 19);
  const commands = await f.commands();
  assert.equal(
    commands.some((entry) => entry.args[0] === "run"),
    false,
  );
  assert.equal(
    commands.some((entry) => entry.sql.includes("DROP TABLE")),
    false,
  );
  cleanupScope(commands);
});
test("MySQL runner rejects the obsolete table count before Go and preserves cleanup", async (t) => {
  const f = await fixture(t),
    result = f.run({ TEST_ONLY_TABLE_COUNT: "31" });
  assert.notEqual(result.status, 0);
  const commands = await f.commands();
  assert.equal(
    commands.some((entry) => entry.args[0] === "run"),
    false,
  );
  cleanupScope(commands);
});
test("MySQL runner preserves actual Go failure instead of claiming rollback acceptance", async (t) => {
  const f = await fixture(t),
    result = f.run({ TEST_ONLY_FAIL_GO: "1" });
  assert.equal(result.status, 23);
  const commands = await f.commands();
  assert.equal(
    commands.some((entry) => entry.sql.includes("DROP TABLE")),
    false,
  );
  cleanupScope(commands);
});
test("MySQL runner rejects malformed port before touching Docker", async (t) => {
  const f = await fixture(t),
    result = f.run({ ARTFI_MYSQL_TEST_PORT: "33306;ignored" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await f.commands(), []);
});
