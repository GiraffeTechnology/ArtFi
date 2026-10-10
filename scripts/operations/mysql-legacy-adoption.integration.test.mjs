// TEST_ONLY: owned fresh datadirs, loopback-only official MySQL, synthetic data.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { OFFICIAL } from "./mysql-legacy-adoption.mjs";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "scripts/operations/mysql-legacy-adoption.mjs");
const base = process.env.ARTFI_MYSQL_BASE;
const sha = (value) => createHash("sha256").update(value).digest("hex");
// CI diagnostics are exact static classifications, never native error text,
// command arguments, connection configuration or SQL/schema values.
const failureMessages = new Map([
  [
    "Full business schema differs from official migrations 1–10; private comparison saved, adoption refused.",
    "SCHEMA_MISMATCH",
  ],
  [
    "MySQL connection ended; verify availability and private client configuration.",
    "MYSQL_CLIENT_FAILURE",
  ],
  ["Unsupported CHECK expression escaping.", "CHECK_EXPRESSION_UNSUPPORTED"],
  [
    "Existing data violates a declared CHECK constraint; adoption refused.",
    "DATA_CONSTRAINT_VIOLATION",
  ],
  [
    "Existing data violates a declared foreign key; adoption refused.",
    "DATA_CONSTRAINT_VIOLATION",
  ],
  [
    "Existing data violates a declared unique index; adoption refused.",
    "DATA_CONSTRAINT_VIOLATION",
  ],
  ["Reference provenance/checksum mismatch.", "REFERENCE_PROVENANCE_MISMATCH"],
  [
    "Reference was built for a different source identity.",
    "SOURCE_IDENTITY_MISMATCH",
  ],
  ["Schema or ledger changed during inspection.", "INSPECTION_DRIFT"],
  ["Cannot read private adoption evidence.", "EVIDENCE_MISSING"],
  [
    "File operation failed; inspect private paths and permissions.",
    "FILE_IO_FAILURE",
  ],
]);
function classifyFailure(error) {
  for (const value of [error.stderr, error.actual]) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    for (const [message, code] of failureMessages)
      if (text === `Legacy adoption error: ${message}`) return code;
  }
  return error.code === "ERR_ASSERTION"
    ? "ASSERTION_FAILED"
    : "UNCLASSIFIED_FAILURE";
}
const schemaComponentNames = [
  "database",
  "tables",
  "columns",
  "indexes",
  "constraints",
  "keys",
  "foreignKeys",
  "checks",
];
async function safeSchemaDifference(path) {
  if (!path) return [];
  try {
    const report = JSON.parse(await readFile(path, "utf8"));
    if (report.kind !== "inspection-refused") return [];
    const original = report.snapshot.schema;
    const excluded = new Set(
      original.constraints
        .filter((row) => row.table === "artfi_deployment_migrations")
        .map((row) => row.name),
    );
    return schemaComponentNames.flatMap((component) => {
      const source = original[component].filter((row) =>
        component === "tables"
          ? row.name !== "artfi_deployment_migrations"
          : component === "checks"
            ? !excluded.has(row.name)
            : row.table !== "artfi_deployment_migrations",
      );
      const reference = report.referenceSchema[component];
      const sourceSha256 = sha(JSON.stringify(source));
      const referenceSha256 = sha(JSON.stringify(reference));
      return sourceSha256 === referenceSha256
        ? []
        : [
            {
              component,
              sourceCount: source.length,
              referenceCount: reference.length,
              sourceSha256,
              referenceSha256,
            },
          ];
    });
  } catch {
    return [];
  }
}
test(
  "official isolated MySQL legacy adoption end-to-end",
  { skip: !base, timeout: 600000 },
  async (t) => {
    const cache = resolve(process.env.ARTFI_LEGACY_TEST_CACHE);
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const run = await mkdtemp(join(cache, "legacy-"));
    await chmod(run, 0o700);
    t.diagnostic(`Private synthetic evidence: ${run}`);
    const env = { ...process.env, TMPDIR: run };
    const bin = (name) =>
      name === "mysqld" && process.env.ARTFI_MYSQL_SERVER_BIN
        ? process.env.ARTFI_MYSQL_SERVER_BIN
        : join(base, "bin", name);
    const command = (file, args, extra = {}) =>
      exec(file, args, {
        env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000,
        ...extra,
      });
    const servers = [];
    const results = [];
    let reference, inspection, backup, restored, plan, planHash;
    const sql = async (server, query, database) =>
      (
        await command(bin("mysql"), [
          `--defaults-file=${server.client}`,
          "--no-login-paths",
          "--default-character-set=utf8mb4",
          "--batch",
          "--raw",
          "--skip-column-names",
          ...(database ? [`--database=${database}`] : []),
          "--execute",
          query,
        ])
      ).stdout.trim();
    t.after(async () => {
      for (const server of servers) {
        if (server.child?.exitCode === null) {
          server.child.kill("SIGTERM");
          await server.closed;
        }
      }
      await writeFile(
        join(run, "summary.json"),
        JSON.stringify(
          {
            scope:
              "TEST_ONLY disposable MySQL, no production credentials or connections",
            serverVersion: "8.4.11",
            results,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    });
    const step = (name, work) =>
      t.test(name, async () => {
        try {
          await work();
          results.push({ name, result: "PASSED" });
        } catch (error) {
          results.push({
            name,
            result: "FAILED",
            failureCode: classifyFailure(error),
            schemaDifferences: await safeSchemaDifference(inspection),
          });
          throw error;
        }
      });
    for (let index = 0; index < 2; index++) {
      const directory = join(run, `server${index}`);
      await mkdir(directory, { mode: 0o700 });
      const data = join(directory, "data");
      await mkdir(data, { mode: 0o700 });
      const server = {
        directory,
        data,
        client: join(directory, "client.cnf"),
        port: Number(process.env.ARTFI_LEGACY_TEST_PORT || 34971) + index,
      };
      servers.push(server);
      await writeFile(
        server.client,
        `[client]\nhost=127.0.0.1\nport=${server.port}\nuser=root\nprotocol=TCP\nssl-mode=DISABLED\n`,
        { mode: 0o600 },
      );
      await command(bin("mysqld"), [
        "--no-defaults",
        "--initialize-insecure",
        `--basedir=${base}`,
        `--datadir=${data}`,
        `--log-error=${directory}/init.log`,
        "--innodb-buffer-pool-size=64M",
        "--innodb-redo-log-capacity=64M",
      ]);
      const ownedUUID = (await readFile(join(data, "auto.cnf"), "utf8")).match(
        /^server-uuid=(.+)$/m,
      )?.[1];
      assert.ok(ownedUUID, "initialized datadir must have its own server UUID");
      server.child = spawn(
        bin("mysqld"),
        [
          "--no-defaults",
          `--basedir=${base}`,
          `--datadir=${data}`,
          "--bind-address=127.0.0.1",
          `--port=${server.port}`,
          "--socket=",
          "--mysqlx=0",
          `--pid-file=${directory}/pid`,
          `--log-error=${directory}/server.log`,
          "--innodb-buffer-pool-size=64M",
          "--innodb-redo-log-capacity=64M",
        ],
        { env, stdio: "ignore" },
      );
      server.closed = new Promise((resolve) =>
        server.child.once("close", resolve),
      );
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          const actualUUID = await sql(server, "SELECT @@server_uuid");
          assert.equal(
            actualUUID,
            ownedUUID,
            "port must belong to this owned disposable datadir",
          );
          ready = true;
          break;
        } catch {
          if (server.child.exitCode !== null) break;
          await delay(100);
        }
      }
      assert.ok(ready, "fresh disposable MySQL should become ready");
    }
    const [source, isolated] = servers;
    const db = "legacy_test_only";
    const migrations = join(root, "apps/api/migrations");
    const common = (server = source, database = db) => [
      "--defaults-file",
      server.client,
      "--database",
      database,
      "--mysql",
      bin("mysql"),
      "--lock-timeout",
      "0",
    ];
    const runCli = async (name, args) =>
      JSON.parse(
        (await command(process.execPath, [cli, name, ...args])).stdout,
      );
    const rejected = async (name, args, match) =>
      assert.rejects(
        command(process.execPath, [cli, name, ...args]),
        (error) => {
          assert.match(error.stderr, match);
          return true;
        },
      );
    const applyArgs = () => [
      ...common(),
      "--migrations",
      migrations,
      "--plan",
      plan,
      "--plan-sha256",
      planHash,
      "--backup",
      backup,
      "--approve-ledger-only",
      "--maintenance-confirmed",
    ];
    const migrated = async (action, directory = migrations) =>
      command(
        process.env.ARTFI_MYSQL_MIGRATOR,
        ["--action", action, "--directory", directory],
        {
          env: {
            ...env,
            MYSQL_DSN: `root@tcp(127.0.0.1:${source.port})/${db}`,
          },
        },
      );
    await step(
      "legacy synthetic database uses exact official 1–10, nondefault collation, and opaque versions",
      async () => {
        await sql(
          source,
          `CREATE DATABASE ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
        );
        for (const file of OFFICIAL)
          await sql(
            source,
            await readFile(join(migrations, file.name), "utf8"),
            db,
          );
        await sql(
          source,
          `CREATE TABLE artfi_deployment_migrations (version VARCHAR(190) PRIMARY KEY, source_sha CHAR(40) NOT NULL, sql_sha256 CHAR(64) NOT NULL, applied_at TIMESTAMP(6) NOT NULL);`,
          db,
        );
        for (let index = 0; index < 10; index++)
          await sql(
            source,
            `INSERT INTO artfi_deployment_migrations VALUES ('legacy-${String.fromCharCode(90 - index)}','${"a".repeat(40)}','${OFFICIAL[index].checksum}','2026-10-01 01:02:03.123456')`,
            db,
          );
        await sql(
          source,
          `INSERT INTO projects (id,slug,name,curator,location,description) VALUES (UNHEX('${"01".repeat(16)}'),'test-only','Synthetic artwork','Synthetic curator','TEST_ONLY','Escaped newline\\nUnicode 春 and quote \\''),(UNHEX('${"02".repeat(16)}'),'test-only-two','Other','Curator','TEST_ONLY','Row two')`,
          db,
        );
        assert.equal(
          await sql(
            source,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            db,
          ),
          "32",
        );
        await assert.rejects(migrated("up"), (error) =>
          /no migration ledger/.test(error.stderr),
        );
      },
    );
    await step(
      "reference construction is isolated and inherits exact source charset/collation",
      async () => {
        reference = join(run, "reference.json");
        await rejected(
          "reference",
          [
            ...common(),
            "--isolated-defaults-file",
            source.client,
            "--isolated-database",
            "artfi_adoption_forbidden",
            "--isolated-target",
            "--migrations",
            migrations,
            "--output",
            join(run, "forbidden.json"),
          ],
          /distinct disposable/,
        );
        await runCli("reference", [
          ...common(),
          "--isolated-defaults-file",
          isolated.client,
          "--isolated-database",
          "artfi_adoption_reference",
          "--isolated-target",
          "--migrations",
          migrations,
          "--output",
          reference,
        ]);
        const ref = JSON.parse(await readFile(reference));
        assert.equal(ref.schema.database[0].collation, "utf8mb4_bin");
        assert.equal(ref.schema.tables.length, 31);
      },
    );
    const inspectArgs = (output) => [
      ...common(),
      "--migrations",
      migrations,
      "--reference",
      reference,
      "--output",
      output,
    ];
    await step(
      "read-only inspection proves full schema and opaque-version checksum mapping",
      async () => {
        inspection = join(run, "inspect.json");
        await runCli("inspect", inspectArgs(inspection));
        const evidence = JSON.parse(await readFile(inspection));
        assert.equal(evidence.snapshot.legacyRows.length, 10);
        assert.equal(evidence.sourceWrites, false);
        assert.ok(evidence.dataAudit.constraintsChecked > 30);
        assert.equal(
          await sql(
            source,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='artfi_schema_migrations'",
            db,
          ),
          "0",
        );
      },
    );
    await step(
      "checksum drift, index drift, CHECK enforcement drift and unsupported objects refuse",
      async () => {
        const first = OFFICIAL[0];
        await sql(
          source,
          `UPDATE artfi_deployment_migrations SET sql_sha256='${"0".repeat(64)}' WHERE sql_sha256='${first.checksum}'`,
          db,
        );
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-checksum.json")),
          /exact official/,
        );
        await sql(
          source,
          `UPDATE artfi_deployment_migrations SET sql_sha256='${first.checksum}' WHERE sql_sha256='${"0".repeat(64)}'`,
          db,
        );
        await sql(
          source,
          "ALTER TABLE assets RENAME INDEX idx_assets_project_status TO drifted_index",
          db,
        );
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-index.json")),
          /Full business schema/,
        );
        await sql(
          source,
          "ALTER TABLE assets RENAME INDEX drifted_index TO idx_assets_project_status",
          db,
        );
        await sql(
          source,
          "ALTER TABLE assets ALTER CHECK chk_assets_valuation NOT ENFORCED",
          db,
        );
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-check.json")),
          /Full business schema/,
        );
        await sql(
          source,
          "ALTER TABLE assets ALTER CHECK chk_assets_valuation ENFORCED",
          db,
        );
        // CHECK string literals carry the connection charset into metadata.
        // A real charset mismatch must remain a refusal, never be normalized away.
        const checkWithCharset = (charset) =>
          `ALTER TABLE external_market_intents DROP CHECK chk_external_market_intent_token_id, ADD CONSTRAINT chk_external_market_intent_token_id CHECK (token_id REGEXP _${charset}'^(0|[1-9][0-9]{0,77})$')`;
        await sql(source, checkWithCharset("latin1"), db);
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-check-charset.json")),
          /Full business schema/,
        );
        await sql(source, checkWithCharset("utf8mb4"), db);
        await sql(
          source,
          "CREATE VIEW unexpected_view AS SELECT id FROM projects",
          db,
        );
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-view.json")),
          /Unsupported schema/,
        );
        await sql(source, "DROP VIEW unexpected_view", db);
      },
    );
    await step(
      "FK data violations are detected and official CHECK constraints remain enforced",
      async () => {
        const insert = (project, valuation) =>
          `INSERT INTO assets (id,project_id,slug,title,artist,creation_year,medium,location,valuation_usd,lifecycle_status,metadata_json) VALUES (UNHEX('${"03".repeat(16)}'),UNHEX('${project}'),'constraint-test','TEST_ONLY','Synthetic',2026,'Synthetic','TEST_ONLY',${valuation},'test','{}')`;
        await sql(
          source,
          `SET foreign_key_checks=0; ${insert("ff".repeat(16), 1)}`,
          db,
        );
        await rejected(
          "inspect",
          inspectArgs(join(run, "bad-fk-data.json")),
          /violates a declared foreign key/,
        );
        await sql(
          source,
          "DELETE FROM assets WHERE slug='constraint-test'",
          db,
        );
        await assert.rejects(
          sql(source, insert("01".repeat(16), -1), db),
          (error) => /Check constraint.*violated/.test(error.stderr),
        );
        assert.equal(
          JSON.parse(await readFile(inspection)).dataAudit
            .payloadHashEqualityAsserted,
          false,
        );
      },
    );
    await step(
      "advisory lock excludes another inspection without creating a ledger",
      async () => {
        const holder = spawn(
          bin("mysql"),
          [
            `--defaults-file=${source.client}`,
            "--no-login-paths",
            `--database=${db}`,
            "--execute",
            "SELECT GET_LOCK(CONCAT('artfi-schema:',DATABASE()),0); SELECT SLEEP(60)",
          ],
          { env, stdio: "ignore" },
        );
        try {
          for (let i = 0; i < 30; i++) {
            if (
              (await sql(
                source,
                "SELECT IS_USED_LOCK(CONCAT('artfi-schema:',DATABASE())) IS NOT NULL",
                db,
              )) === "1"
            )
              break;
            await delay(50);
          }
          await rejected(
            "inspect",
            inspectArgs(join(run, "locked.json")),
            /Cannot acquire schema migration lock/,
          );
        } finally {
          const connection = await sql(
            source,
            "SELECT IS_USED_LOCK(CONCAT('artfi-schema:',DATABASE()))",
            db,
          );
          if (/^\d+$/.test(connection)) await sql(source, `KILL ${connection}`);
          holder.kill("SIGTERM");
        }
      },
    );
    await step(
      "consistent legacy backup and isolated restore prove exact dump data, schema and ledger",
      async () => {
        backup = join(run, "backup");
        await runCli("backup", [
          ...common(),
          "--inspect",
          inspection,
          "--output",
          backup,
          "--mysqldump",
          bin("mysqldump"),
        ]);
        restored = join(run, "restore.json");
        await runCli("restore-check", [
          ...common(isolated, "artfi_adoption_restore"),
          "--backup",
          backup,
          "--trusted-backup",
          "--isolated-target",
          "--mysqldump",
          bin("mysqldump"),
          "--output",
          restored,
        ]);
        const result = JSON.parse(await readFile(restored));
        assert.equal(result.activated, false);
        assert.equal(result.data.rows, 12);
        assert.notEqual(
          result.isolatedIdentity.serverUuid,
          result.sourceIdentity.serverUuid,
        );
        await rejected(
          "restore-check",
          [
            ...common(source, "artfi_adoption_forbidden_restore"),
            "--backup",
            backup,
            "--trusted-backup",
            "--isolated-target",
            "--output",
            join(run, "badrestore.json"),
          ],
          /distinct disposable/,
        );
      },
    );
    await step(
      "private hashed plan binds the complete tool-generated evidence chain",
      async () => {
        plan = join(run, "plan.json");
        const result = await runCli("plan", [
          "--inspect",
          inspection,
          "--backup",
          backup,
          "--restore-evidence",
          restored,
          "--output",
          plan,
        ]);
        planHash = result.sha256;
        assert.equal(sha(await readFile(plan)), planHash);
        await rejected(
          "apply",
          applyArgs().map((value) =>
            value === planHash ? "0".repeat(64) : value,
          ),
          /SHA-256 does not match/,
        );
        await rejected(
          "apply",
          applyArgs().filter((value) => value !== "--approve-ledger-only"),
          /required option/,
        );
      },
    );
    await step(
      "modified historical source files and backup corruption refuse before any ledger write",
      async () => {
        const changed = join(run, "changed-migrations");
        await cp(migrations, changed, { recursive: true });
        await writeFile(
          join(changed, OFFICIAL[0].name),
          (await readFile(join(changed, OFFICIAL[0].name), "utf8")) +
            "\n-- TEST_ONLY corruption\n",
        );
        await rejected(
          "apply",
          applyArgs().map((value) => (value === migrations ? changed : value)),
          /historical migration checksum mismatch/,
        );
        const corrupt = join(run, "corrupt-backup");
        await cp(backup, corrupt, { recursive: true });
        await chmod(corrupt, 0o700);
        await writeFile(
          join(corrupt, "database.sql"),
          (await readFile(join(corrupt, "database.sql"), "utf8")) +
            "\n-- TEST_ONLY corruption\n",
          { mode: 0o600 },
        );
        await rejected(
          "apply",
          applyArgs().map((value) => (value === backup ? corrupt : value)),
          /Backup bytes or data digest changed/,
        );
      },
    );
    await step(
      "source schema/old-row drift between plan and apply refuses with no final ledger",
      async () => {
        await sql(source, "ALTER TABLE projects ADD COLUMN unexpected INT", db);
        await rejected("apply", applyArgs(), /drifted/);
        await sql(source, "ALTER TABLE projects DROP COLUMN unexpected", db);
        await sql(
          source,
          "UPDATE artfi_deployment_migrations SET source_sha=REPEAT('b',40) WHERE version='legacy-Z'",
          db,
        );
        await rejected("apply", applyArgs(), /drifted/);
        await sql(
          source,
          "UPDATE artfi_deployment_migrations SET source_sha=REPEAT('a',40) WHERE version='legacy-Z'",
          db,
        );
      },
    );
    await step(
      "real privilege failure after CREATE cannot expose an empty canonical ledger",
      async () => {
        await sql(
          source,
          `CREATE USER 'legacy_noinsert'@'127.0.0.1'; GRANT SELECT,CREATE ON ${db}.* TO 'legacy_noinsert'@'127.0.0.1'`,
        );
        const client = join(run, "noinsert.cnf");
        await writeFile(
          client,
          (await readFile(source.client, "utf8")).replace(
            "user=root",
            "user=legacy_noinsert",
          ),
          { mode: 0o600 },
        );
        await rejected(
          "apply",
          applyArgs().map((value) =>
            value === source.client ? client : value,
          ),
          /MySQL connection ended/,
        );
        const tables = await sql(
          source,
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'artfi_adopt_%'",
          db,
        );
        assert.match(tables, /^artfi_adopt_[a-f0-9]+$/);
        assert.equal(
          await sql(source, `SELECT COUNT(*) FROM ${tables}`, db),
          "0",
        );
        assert.equal(
          await sql(
            source,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='artfi_schema_migrations'",
            db,
          ),
          "0",
        );
        await assert.rejects(migrated("up"), (error) =>
          /no migration ledger/.test(error.stderr),
        );
        await rejected("apply", applyArgs(), /drifted/);
        // Test fixture cleanup only, never an automatic operation in the shipped tool.
        await sql(source, `DROP TABLE ${tables}`, db);
      },
    );
    await step(
      "real RENAME privilege failure preserves all staged rows and no canonical ledger",
      async () => {
        await sql(
          source,
          `CREATE USER 'legacy_norename'@'127.0.0.1'; GRANT SELECT,CREATE,INSERT ON ${db}.* TO 'legacy_norename'@'127.0.0.1'`,
        );
        const client = join(run, "norename.cnf");
        await writeFile(
          client,
          (await readFile(source.client, "utf8")).replace(
            "user=root",
            "user=legacy_norename",
          ),
          { mode: 0o600 },
        );
        await rejected(
          "apply",
          applyArgs().map((value) =>
            value === source.client ? client : value,
          ),
          /MySQL connection ended/,
        );
        const tables = await sql(
          source,
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'artfi_adopt_%'",
          db,
        );
        assert.match(tables, /^artfi_adopt_[a-f0-9]+$/);
        assert.equal(
          await sql(source, `SELECT COUNT(*) FROM ${tables}`, db),
          "10",
        );
        assert.equal(
          await sql(
            source,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='artfi_schema_migrations'",
            db,
          ),
          "0",
        );
        await sql(source, `DROP TABLE ${tables}`, db);
      },
    );
    await step(
      "adoption registers ten records atomically and preserves business and old-ledger data",
      async () => {
        const old = await sql(
          source,
          "SELECT * FROM artfi_deployment_migrations ORDER BY version",
          db,
        );
        const data = await sql(
          source,
          "SELECT * FROM projects ORDER BY id",
          db,
        );
        assert.equal((await runCli("apply", applyArgs())).result, "APPLIED");
        assert.equal(
          await sql(
            source,
            "SELECT COUNT(*) FROM artfi_schema_migrations WHERE dirty=0",
            db,
          ),
          "10",
        );
        assert.equal(
          await sql(
            source,
            "SELECT * FROM artfi_deployment_migrations ORDER BY version",
            db,
          ),
          old,
        );
        assert.equal(
          await sql(source, "SELECT * FROM projects ORDER BY id", db),
          data,
        );
        assert.equal(
          (await runCli("apply", applyArgs())).result,
          "ALREADY_APPLIED",
        );
      },
    );
    await step(
      "dirty and mismatched preexisting canonical ledgers refuse without repair",
      async () => {
        await sql(
          source,
          `UPDATE artfi_schema_migrations SET dirty=1 WHERE name='${OFFICIAL[0].name}'`,
          db,
        );
        await rejected(
          "apply",
          applyArgs(),
          /not the exact completed adoption/,
        );
        await sql(source, "UPDATE artfi_schema_migrations SET dirty=0", db);
        await sql(
          source,
          `UPDATE artfi_schema_migrations SET checksum=REPEAT('0',64) WHERE name='${OFFICIAL[0].name}'`,
          db,
        );
        await rejected(
          "apply",
          applyArgs(),
          /not the exact completed adoption/,
        );
        await sql(
          source,
          `UPDATE artfi_schema_migrations SET checksum='${OFFICIAL[0].checksum}' WHERE name='${OFFICIAL[0].name}'`,
          db,
        );
      },
    );
    await step(
      "unchanged installer sees exactly four pending migrations, then safely applies 11–14",
      async () => {
        assert.equal(JSON.parse((await migrated("status")).stdout).pending, 4);
        assert.equal(JSON.parse((await migrated("up")).stdout).pending, 0);
        assert.equal(
          await sql(source, "SELECT COUNT(*) FROM artfi_schema_migrations", db),
          "14",
        );
        await rejected("apply", applyArgs(), /drifted/);
      },
    );
  },
);
