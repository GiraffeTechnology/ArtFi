// All state is created under a fresh, private TEST_ONLY directory. Both servers
// bind only to loopback; no existing database, account or network setting is used.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "scripts/operations/mysql-recovery.mjs");
const base = process.env.ARTFI_MYSQL_BASE;
const enabled = Boolean(
  base &&
  process.env.ARTFI_MYSQL_TEST_CACHE &&
  process.env.ARTFI_MYSQL_MIGRATOR,
);
const sha = (value) => createHash("sha256").update(value).digest("hex");

test(
  "isolated MySQL 8 primary/replica and backup/restore lifecycle",
  { skip: !enabled, timeout: 600_000 },
  async (t) => {
    const cache = resolve(process.env.ARTFI_MYSQL_TEST_CACHE);
    await mkdir(cache, { recursive: true });
    const run = await mkdtemp(join(cache, "m6-mysql-"));
    await chmod(run, 0o700);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: `${base}/usr/lib/x86_64-linux-gnu:${base}/lib/private`,
      TMPDIR: run,
    };
    const bin = (name) =>
      name === "mysqld" && process.env.ARTFI_MYSQL_SERVER_BIN
        ? process.env.ARTFI_MYSQL_SERVER_BIN
        : join(base, "bin", name);
    const port = +(process.env.ARTFI_MYSQL_TEST_PORT || 34860);
    const db = "artfi_m6_test_only";
    const restored = "artfi_m6_restored_test_only";
    const migrator = process.env.ARTFI_MYSQL_MIGRATOR;
    const servers = [];
    const results = [];
    const migrationHashes = {};
    const evidence = {
      scope: "TEST_ONLY loopback, synthetic records, no production access",
      run,
      serverVersion: null,
      migrationHashes,
      results,
    };
    const saveEvidence = () =>
      writeFile(
        join(run, "summary.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
    t.diagnostic(`TEST_ONLY artifacts: ${run}`);
    const command = async (file, args, extra = {}) =>
      exec(file, args, {
        env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
        killSignal: "SIGKILL",
        ...extra,
      });
    const sql = async (server, query, database) => {
      const result = await command(bin("mysql"), [
        `--defaults-file=${server.client}`,
        "--no-login-paths",
        "--batch",
        "--raw",
        "--skip-column-names",
        ...(database ? [`--database=${database}`] : []),
        "--execute",
        query,
      ]);
      return result.stdout.trim();
    };
    const launch = async (server) => {
      server.child = spawn(
        bin("mysqld"),
        [`--defaults-file=${server.config}`],
        { env, stdio: ["ignore", "ignore", "ignore"] },
      );
      server.child.on("error", () => {});
      server.closed = new Promise((resolveChild) =>
        server.child.once("close", resolveChild),
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.child.exitCode !== null)
          throw new Error(
            `TEST_ONLY ${server.name} exited; inspect its private server log.`,
          );
        try {
          await sql(server, "SELECT 1");
          return;
        } catch {
          await delay(200);
        }
      }
      throw new Error(`TEST_ONLY ${server.name} did not become ready.`);
    };
    const stop = async (server) => {
      if (server.child && server.child.exitCode === null) {
        server.child.kill("SIGTERM");
        await server.closed;
      }
    };
    t.after(async () => {
      for (const server of servers) await stop(server);
      await saveEvidence();
    });
    const step = async (name, work) =>
      t.test(name, async () => {
        const startedAt = new Date().toISOString();
        try {
          await work();
          results.push({
            name,
            result: "PASSED",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
        } catch (error) {
          results.push({
            name,
            result: "FAILED",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          throw error;
        } finally {
          await saveEvidence();
        }
      });
    const cliOptions = (server, database = db) => [
      "--defaults-file",
      server.client,
      "--database",
      database,
      "--mysql",
      bin("mysql"),
    ];
    const runCli = async (commandName, args) =>
      JSON.parse(
        (await command(process.execPath, [cli, commandName, ...args])).stdout,
      );
    const backupArgs = (server, output, database = db) => [
      ...cliOptions(server, database),
      "--mysqldump",
      bin("mysqldump"),
      "--output",
      output,
    ];
    const restoreArgs = (backupPath, target = restored) => [
      ...cliOptions(servers[0], target),
      "--backup",
      backupPath,
      "--trusted-backup",
    ];
    const expectCliFailure = async (name, args, message) => {
      await assert.rejects(
        command(process.execPath, [cli, name, ...args]),
        (error) => {
          assert.match(error.stderr, message);
          assert.doesNotMatch(error.stderr, /SOURCE_PASSWORD|TEST_ONLY_SECRET/);
          return true;
        },
      );
    };

    await step(
      "fresh primary/replica servers use durable GTID configuration and read-only replica",
      async () => {
        for (let index = 0; index < 2; index++) {
          const name = index === 0 ? "primary" : "replica";
          const directory = join(run, name);
          await mkdir(directory, { mode: 0o700 });
          const data = join(directory, "data");
          await mkdir(data, { mode: 0o700 });
          const server = {
            name,
            directory,
            data,
            port: port + index,
            client: join(directory, "client.cnf"),
            config: join(directory, "server.cnf"),
          };
          servers.push(server);
          await writeFile(
            server.client,
            `[client]\nhost=127.0.0.1\nport=${server.port}\nuser=root\nprotocol=TCP\nssl-mode=DISABLED\n`,
            { mode: 0o600 },
          );
          // Passwordless root is confined to disposable loopback TEST_ONLY servers.
          await command(bin("mysqld"), [
            "--no-defaults",
            "--initialize-insecure",
            `--basedir=${base}`,
            `--datadir=${data}`,
            `--log-error=${directory}/initialize.log`,
            "--innodb-buffer-pool-size=64M",
            "--innodb-redo-log-capacity=64M",
          ]);
          const template = await readFile(
            join(root, "scripts/operations", `mysql-${name}.cnf.example`),
            "utf8",
          );
          const config = template
            .replaceAll(
              index ? "REPLICA_UNIQUE_SERVER_ID" : "PRIMARY_UNIQUE_SERVER_ID",
              `${index + 78101}`,
            )
            .replaceAll("PRIVATE_SERVICE_BIND_ADDRESS", "127.0.0.1")
            .replaceAll("ALLOCATED_MYSQL_PORT", `${server.port}`)
            .replaceAll(`/OPERATOR_PROVISIONED/mysql-${name}`, data)
            // Only this disposable TEST_ONLY fixture overrides transport TLS.
            .replace(
              "require-secure-transport=ON",
              "require-secure-transport=OFF",
            )
            .replace(/^ssl-(?:ca|cert|key)=.*\n/gm, "");
          await writeFile(
            server.config,
            `${config}\nbasedir=${base}\nsocket=\npid-file=${directory}/server.pid\nlog-error=${directory}/server.log\ntmpdir=${run}\ninnodb-buffer-pool-size=64M\ninnodb-redo-log-capacity=64M\ninnodb-temp-data-file-path=ibtmp1:12M:autoextend:max:64M\n`,
            { mode: 0o600 },
          );
          await launch(server);
        }
        assert.equal(
          await sql(
            servers[0],
            "SELECT @@gtid_mode,@@binlog_format,@@read_only,@@super_read_only",
          ),
          "ON\tROW\t0\t0",
        );
        assert.equal(
          await sql(
            servers[1],
            "SELECT @@gtid_mode,@@binlog_format,@@read_only,@@super_read_only",
          ),
          "ON\tROW\t1\t1",
        );
        evidence.serverVersion = await sql(servers[0], "SELECT VERSION()");
      },
    );
    const [primary, replica] = servers;
    const catchUp = async () => {
      const gtid = await sql(primary, "SELECT @@GLOBAL.gtid_executed");
      assert.match(gtid, /^[0-9a-f,:\-\n]+$/);
      assert.equal(
        await sql(replica, `SELECT WAIT_FOR_EXECUTED_GTID_SET('${gtid}',20)`),
        "0",
      );
    };

    await step(
      "all checked-in migrations apply through the precompiled installer and replicate",
      async () => {
        await sql(
          replica,
          `CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1',SOURCE_PORT=${primary.port},SOURCE_USER='root',SOURCE_PASSWORD='',SOURCE_AUTO_POSITION=1,SOURCE_SSL=0,SOURCE_CONNECT_RETRY=1; START REPLICA`,
        );
        await sql(
          primary,
          `CREATE DATABASE ${db} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; CREATE DATABASE ${restored} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        const migrationDirectory = join(root, "apps/api/migrations");
        for (const name of (await readdir(migrationDirectory))
          .filter((name) => name.endsWith(".up.sql"))
          .sort())
          migrationHashes[name] = sha(
            await readFile(join(migrationDirectory, name)),
          );
        const migrated = await command(
          migrator,
          ["-directory", migrationDirectory, "-action", "up"],
          {
            env: {
              ...env,
              MYSQL_DSN: `root@tcp(127.0.0.1:${primary.port})/${db}?parseTime=true`,
            },
          },
        );
        const report = JSON.parse(migrated.stdout);
        assert.equal(report.pending, 0);
        assert.equal(
          report.migrations.length,
          Object.keys(migrationHashes).length,
        );
        assert.ok(
          report.migrations.every(
            (migration) => migration.applied && !migration.dirty,
          ),
        );
        await sql(
          primary,
          `INSERT INTO projects (id,slug,name,curator,location,description) VALUES (UNHEX('00000000000000000000000000000001'),'test-only-m6','TEST_ONLY MySQL recovery','Synthetic curator','Loopback','No real artwork or rights'); CREATE TABLE test_only_recovery_payload (id INT PRIMARY KEY, payload LONGBLOB, text_value TEXT, amount DECIMAL(30,10), json_value JSON, nullable_value VARCHAR(30) NULL) ENGINE=InnoDB; INSERT INTO test_only_recovery_payload VALUES (1,UNHEX('0001FF805C27'),'TEST_ONLY Unicode 恢复 🖼️ and newline\\ntext',12345678901234567890.1234567890,JSON_OBJECT('scope','TEST_ONLY','nested',JSON_ARRAY(1,true,NULL)),NULL),(2,UNHEX('DEADBEEF'),'TEST_ONLY second',-123.0000000001,JSON_OBJECT('ok',true),'present')`,
          db,
        );
        await catchUp();
        assert.equal(
          await sql(replica, "SELECT COUNT(*) FROM projects", db),
          "1",
        );
        assert.equal(
          await sql(
            replica,
            "SELECT COUNT(*) FROM artfi_schema_migrations",
            db,
          ),
          `${Object.keys(migrationHashes).length}`,
        );
      },
    );

    const backupPath = join(run, "complete-backup");
    let manifest;
    await step(
      "backup captures every InnoDB table, complete schema and clean migration ledger",
      async () => {
        const result = await runCli("backup", backupArgs(primary, backupPath));
        assert.equal(result.result, "PASSED");
        manifest = JSON.parse(
          await readFile(join(backupPath, "manifest.json")),
        );
        assert.equal(
          manifest.ledger.length,
          Object.keys(migrationHashes).length,
        );
        assert.equal(
          manifest.schema.tables.length,
          +(await sql(
            primary,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            db,
          )),
        );
        assert.equal((await stat(backupPath)).mode & 0o777, 0o700);
        assert.equal(
          (await stat(join(backupPath, "database.sql"))).mode & 0o777,
          0o600,
        );
        const dump = await readFile(join(backupPath, "database.sql"), "utf8");
        assert.doesNotMatch(
          dump,
          /^(?:DROP |CREATE DATABASE|USE |CHANGE REPLICATION|RESET )/m,
        );
        assert.equal(
          (await runCli("verify", ["--backup", backupPath])).result,
          "PASSED",
        );
        evidence.backup = {
          sha256: result.sha256,
          bytes: result.bytes,
          schemaSha256: result.schemaSha256,
          tables: result.tables,
          migrations: result.migrations,
        };
      },
    );

    await step(
      "empty-database restore preserves all table data, schema and migration hashes",
      async () => {
        const result = await runCli("restore", restoreArgs(backupPath));
        assert.equal(result.result, "PASSED");
        assert.equal(result.activated, false);
        const tables = manifest.schema.tables.map((table) => table.name);
        for (const table of tables) {
          const source = (
            await sql(primary, `CHECKSUM TABLE \`${table}\` EXTENDED`, db)
          ).split("\t")[1];
          const target = (
            await sql(primary, `CHECKSUM TABLE \`${table}\` EXTENDED`, restored)
          ).split("\t")[1];
          assert.match(
            source,
            /^\d+$/,
            `${table} exposes a real data checksum`,
          );
          assert.equal(target, source, `${table} checksum`);
        }
        assert.equal(
          await sql(
            primary,
            "SELECT HEX(payload),amount,nullable_value IS NULL FROM test_only_recovery_payload WHERE id=1",
            restored,
          ),
          "0001FF805C27\t12345678901234567890.1234567890\t1",
        );
        const check = await command(
          migrator,
          [
            "-directory",
            join(root, "apps/api/migrations"),
            "-action",
            "status",
          ],
          {
            env: {
              ...env,
              MYSQL_DSN: `root@tcp(127.0.0.1:${primary.port})/${restored}?parseTime=true`,
            },
          },
        );
        assert.equal(JSON.parse(check.stdout).pending, 0);
        await catchUp();
        assert.equal(
          await sql(
            replica,
            "SELECT COUNT(*) FROM test_only_recovery_payload",
            restored,
          ),
          "2",
        );
      },
    );

    await step(
      "nonempty target and existing backup directory refuse without overwriting",
      async () => {
        await expectCliFailure("restore", restoreArgs(backupPath), /not empty/);
        await expectCliFailure(
          "backup",
          backupArgs(primary, backupPath),
          /File operation failed/,
        );
        assert.equal(
          await sql(
            primary,
            "SELECT COUNT(*) FROM test_only_recovery_payload",
            restored,
          ),
          "2",
        );
        assert.equal(
          (await runCli("verify", ["--backup", backupPath])).sha256,
          manifest.sha256,
        );
      },
    );

    await step(
      "corrupt SQL and tampered schema manifests are rejected before target mutation",
      async () => {
        const target = "artfi_m6_corruption_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${target} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        const corrupt = join(run, "corrupt-backup");
        await cp(backupPath, corrupt, { recursive: true });
        await chmod(corrupt, 0o700);
        await writeFile(
          join(corrupt, "database.sql"),
          "-- TEST_ONLY corruption\n",
          { flag: "a" },
        );
        await expectCliFailure(
          "restore",
          restoreArgs(corrupt, target),
          /checksum or size mismatch/,
        );
        assert.equal(
          await sql(
            primary,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            target,
          ),
          "0",
        );
        await writeFile(
          join(corrupt, "manifest.json"),
          JSON.stringify({ ...manifest, schemaSha256: "0".repeat(64) }),
        );
        await expectCliFailure(
          "verify",
          ["--backup", corrupt],
          /schema checksum/,
        );
      },
    );

    await step(
      "dirty migration ledger and unsupported nontransactional schemas cannot yield backup success",
      async () => {
        await sql(
          primary,
          "UPDATE artfi_schema_migrations SET dirty=1 WHERE name=(SELECT name FROM (SELECT name FROM artfi_schema_migrations ORDER BY name LIMIT 1) AS fixture)",
          db,
        );
        await expectCliFailure(
          "backup",
          backupArgs(primary, join(run, "dirty-backup")),
          /dirty or invalid/,
        );
        await sql(primary, "UPDATE artfi_schema_migrations SET dirty=0", db);
        const unsupported = "artfi_m6_unsupported_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${unsupported}; CREATE TABLE ${unsupported}.test_only_myisam (id INT) ENGINE=MyISAM`,
        );
        await expectCliFailure(
          "backup",
          backupArgs(primary, join(run, "myisam-backup"), unsupported),
          /Unsupported schema/,
        );
        const views = "artfi_m6_view_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${views}; CREATE VIEW ${views}.test_only_view AS SELECT 1 AS id`,
        );
        await expectCliFailure(
          "backup",
          backupArgs(primary, join(run, "view-backup"), views),
          /Unsupported schema/,
        );
      },
    );

    await step(
      "the shared migration lock excludes a simultaneous backup and restore",
      async () => {
        const locker = spawn(
          bin("mysql"),
          [
            `--defaults-file=${primary.client}`,
            "--no-login-paths",
            "--batch",
            "--skip-column-names",
            "--unbuffered",
            `--database=${db}`,
          ],
          { env, stdio: ["pipe", "pipe", "ignore"] },
        );
        const ready = new Promise((resolveReady) =>
          locker.stdout.once("data", resolveReady),
        );
        locker.stdin.write(
          "SELECT GET_LOCK(CONCAT('artfi-schema:', DATABASE()),1);\n",
        );
        await ready;
        try {
          await expectCliFailure(
            "backup",
            [
              ...backupArgs(primary, join(run, "locked-backup")),
              "--lock-timeout",
              "0",
            ],
            /Cannot acquire schema migration lock/,
          );
          await expectCliFailure(
            "restore",
            [...restoreArgs(backupPath, db), "--lock-timeout", "0"],
            /Cannot acquire schema migration lock/,
          );
        } finally {
          locker.stdin.end();
          await new Promise((resolveClosed) =>
            locker.once("close", resolveClosed),
          );
        }
      },
    );

    await step(
      "single-transaction snapshot remains consistent while two related tables are updated",
      async () => {
        await sql(
          primary,
          "CREATE TABLE test_only_snapshot_a (id INT PRIMARY KEY,generation INT NOT NULL) ENGINE=InnoDB; CREATE TABLE test_only_snapshot_b (id INT PRIMARY KEY,generation INT NOT NULL) ENGINE=InnoDB; INSERT INTO test_only_snapshot_a VALUES(1,0); INSERT INTO test_only_snapshot_b VALUES(1,0)",
          db,
        );
        const writer = spawn(
          bin("mysql"),
          [
            `--defaults-file=${primary.client}`,
            "--no-login-paths",
            "--batch",
            `--database=${db}`,
          ],
          { env, stdio: ["pipe", "ignore", "ignore"] },
        );
        const writerClosed = new Promise((resolveClosed) =>
          writer.once("close", resolveClosed),
        );
        writer.stdin.on("error", () => {});
        writer.stdin.end(
          Array.from(
            { length: 2000 },
            (_, index) =>
              `START TRANSACTION; UPDATE test_only_snapshot_a SET generation=${index + 1}; DO SLEEP(0.002); UPDATE test_only_snapshot_b SET generation=${index + 1}; COMMIT;`,
          ).join("\n"),
        );
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (
              +(await sql(
                primary,
                "SELECT generation FROM test_only_snapshot_a",
                db,
              )) > 0
            )
              break;
            await delay(10);
          }
          const concurrent = join(run, "concurrent-backup");
          await runCli("backup", backupArgs(primary, concurrent));
          const target = "artfi_m6_snapshot_test_only";
          await sql(
            primary,
            `CREATE DATABASE ${target} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
          );
          await runCli("restore", restoreArgs(concurrent, target));
          const a = +(await sql(
            primary,
            "SELECT generation FROM test_only_snapshot_a",
            target,
          ));
          const b = +(await sql(
            primary,
            "SELECT generation FROM test_only_snapshot_b",
            target,
          ));
          assert.equal(
            a,
            b,
            "related tables represent the same committed transaction",
          );
          assert.ok(
            a > 0 && a < 2000,
            "snapshot was captured during the active writer",
          );
          evidence.concurrentSnapshotGeneration = a;
        } finally {
          writer.kill("SIGTERM");
          await writerClosed;
        }
      },
    );

    await step(
      "failed dump leaves no completed manifest and an empty target collation mismatch is refused",
      async () => {
        const fake = join(run, "failed-test-only-mysqldump");
        await writeFile(
          fake,
          "#!/bin/sh\nprintf '%s\\n' '-- TEST_ONLY partial dump'\nprintf 'TEST_ONLY_SECRET_MUST_NOT_LEAK' >&2\nexit 1\n",
          { mode: 0o700 },
        );
        const incomplete = join(run, "interrupted-backup");
        await expectCliFailure(
          "backup",
          [...cliOptions(primary), "--mysqldump", fake, "--output", incomplete],
          /no success was recorded/,
        );
        await assert.rejects(stat(join(incomplete, "manifest.json")), {
          code: "ENOENT",
        });
        await expectCliFailure(
          "verify",
          ["--backup", incomplete],
          /Cannot read/,
        );
        const target = "artfi_m6_collation_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${target} CHARACTER SET latin1 COLLATE latin1_swedish_ci`,
        );
        await expectCliFailure(
          "restore",
          restoreArgs(backupPath, target),
          /character set\/collation differs/,
        );
        assert.equal(
          await sql(
            primary,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            target,
          ),
          "0",
        );
      },
    );

    await step(
      "an interrupted import remains isolated and cannot be restored over a second time",
      async () => {
        const partial = join(run, "test-only-invalid-import");
        await cp(backupPath, partial, { recursive: true });
        await chmod(partial, 0o700);
        const badSql =
          (await readFile(join(partial, "database.sql"), "utf8")) +
          "\nTEST_ONLY_INTENTIONAL_INVALID_SQL;\n";
        await writeFile(join(partial, "database.sql"), badSql);
        await writeFile(
          join(partial, "manifest.json"),
          JSON.stringify({
            ...manifest,
            sha256: sha(badSql),
            bytes: Buffer.byteLength(badSql),
          }),
        );

        const target = "artfi_m6_partial_restore_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${target} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        await expectCliFailure(
          "restore",
          restoreArgs(partial, target),
          /no success was recorded/,
        );
        assert.ok(
          +(await sql(
            primary,
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
            target,
          )) > 0,
        );
        await expectCliFailure(
          "restore",
          restoreArgs(backupPath, target),
          /not empty/,
        );
      },
    );

    await step(
      "loss of the lock connection aborts an in-progress backup",
      async () => {
        const fake = join(run, "waiting-test-only-mysqldump");
        await writeFile(
          fake,
          "#!/bin/sh\nprintf '%s\\n' '-- TEST_ONLY partial dump'\nexec sleep 30\n",
          { mode: 0o700 },
        );
        const incomplete = join(run, "lost-lock-backup");
        const pending = command(process.execPath, [
          cli,
          "backup",
          ...cliOptions(primary),
          "--mysqldump",
          fake,
          "--output",
          incomplete,
        ]).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let started = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if (
              (await stat(join(incomplete, "database.sql.partial"))).size > 0
            ) {
              started = true;
              break;
            }
          } catch {}
          await delay(20);
        }
        assert.equal(started, true, "dump reached the held-lock phase");
        const owner = await sql(
          primary,
          `SELECT IS_USED_LOCK('artfi-schema:${db}')`,
        );
        assert.match(owner, /^\d+$/);
        const killedAt = Date.now();
        await sql(primary, `KILL CONNECTION ${owner}`);
        const outcome = await pending;
        assert.ok(
          Date.now() - killedAt < 10_000,
          "lock polling aborts the 30-second dump promptly",
        );
        assert.ok(outcome.error, "a lost lock must not produce success");
        assert.match(
          outcome.error.stderr,
          /no success was recorded|MySQL connection ended/,
        );
        await assert.rejects(stat(join(incomplete, "manifest.json")), {
          code: "ENOENT",
        });
        assert.equal(
          await sql(primary, `SELECT IS_USED_LOCK('artfi-schema:${db}')`),
          "NULL",
        );
      },
    );

    await step(
      "replica restart persists read-only configuration and catches up missed writes",
      async () => {
        await catchUp();
        await stop(replica);
        await sql(
          primary,
          "INSERT INTO test_only_recovery_payload (id,text_value) VALUES (3,'TEST_ONLY while replica stopped')",
          db,
        );
        await launch(replica);
        await catchUp();
        assert.equal(
          await sql(
            replica,
            "SELECT COUNT(*) FROM test_only_recovery_payload",
            db,
          ),
          "3",
        );
        assert.equal(
          await sql(replica, "SELECT @@read_only,@@super_read_only"),
          "1\t1",
        );
        await assert.rejects(
          sql(
            replica,
            "INSERT INTO test_only_recovery_payload (id) VALUES (99)",
            db,
          ),
        );
      },
    );

    await step(
      "primary outage is reported without replica promotion and restart resumes replication",
      async () => {
        await stop(primary);
        await expectCliFailure("status", cliOptions(primary), /MySQL/);
        assert.equal(
          await sql(replica, "SELECT @@read_only,@@super_read_only"),
          "1\t1",
        );
        let replicaStatus;
        await assert.rejects(
          command(process.execPath, [cli, "status", ...cliOptions(replica)]),
          (error) => {
            assert.equal(error.code, 2);
            replicaStatus = JSON.parse(error.stdout);
            assert.equal(replicaStatus.result, "DEGRADED");
            assert.equal(replicaStatus.replicationHealthy, false);
            return true;
          },
        );
        assert.equal(replicaStatus.automaticPromotion, false);
        assert.equal(replicaStatus.server.superReadOnly, 1);
        await launch(primary);
        await sql(
          primary,
          "INSERT INTO test_only_recovery_payload (id,text_value) VALUES (4,'TEST_ONLY after primary restart')",
          db,
        );
        await catchUp();
        assert.equal(
          await sql(
            replica,
            "SELECT COUNT(*) FROM test_only_recovery_payload",
            db,
          ),
          "4",
        );
        const status = await runCli("status", cliOptions(replica));
        assert.ok(
          status.connections.every(
            (row) => row.state === "ON" && row.errorNumber === 0,
          ),
        );
        assert.ok(status.appliers.every((row) => row.state === "ON"));
        assert.ok(
          status.workers.every(
            (row) => row.state === "ON" && row.errorNumber === 0,
          ),
        );
      },
    );
    await step(
      "replica backup roundtrip and final source fingerprints remain consistent",
      async () => {
        const replicaBackup = join(run, "replica-backup");
        await runCli("backup", backupArgs(replica, replicaBackup));
        const target = "artfi_m6_replica_restore_test_only";
        await sql(
          primary,
          `CREATE DATABASE ${target} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
        );
        await runCli("restore", restoreArgs(replicaBackup, target));
        assert.equal(
          await sql(
            primary,
            "SELECT COUNT(*) FROM test_only_recovery_payload",
            target,
          ),
          "4",
        );
        for (const [name, checksum] of Object.entries(migrationHashes))
          assert.equal(
            sha(await readFile(join(root, "apps/api/migrations", name))),
            checksum,
          );
        evidence.sourceHashes = {};
        for (const name of [
          "mysql-recovery.mjs",
          "mysql-recovery.test.mjs",
          "mysql-integration.test.mjs",
          "mysql-primary.cnf.example",
          "mysql-replica.cnf.example",
          "mysql-client.cnf.example",
          "mysql-ci-test.sh",
        ])
          evidence.sourceHashes[`scripts/operations/${name}`] = sha(
            await readFile(join(root, "scripts/operations", name)),
          );
        evidence.migratorSha256 = sha(await readFile(migrator));
        evidence.sourceHashes["docs/MYSQL_RECOVERY.md"] = sha(
          await readFile(join(root, "docs/MYSQL_RECOVERY.md")),
        );
      },
    );
  },
);
