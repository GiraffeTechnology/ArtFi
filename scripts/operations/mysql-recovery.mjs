#!/usr/bin/env node
// M6.2: portable operations tooling; only official MySQL client prerequisites.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT = "artfi-mysql-backup-v1";
const SQL_FILE = "database.sql";
const MANIFEST_FILE = "manifest.json";
const MAX_QUERY_BYTES = 32 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => new Error(message);

export function parseArguments(argv) {
  const [command = "help", ...args] = argv;
  const allowed = {
    help: [],
    backup: [
      "defaults-file",
      "database",
      "output",
      "mysql",
      "mysqldump",
      "lock-timeout",
      "timeout-seconds",
    ],
    restore: [
      "defaults-file",
      "database",
      "backup",
      "mysql",
      "trusted-backup",
      "lock-timeout",
      "timeout-seconds",
    ],
    verify: ["backup"],
    status: ["defaults-file", "database", "mysql", "timeout-seconds"],
  };
  if (!Object.hasOwn(allowed, command))
    throw fail("Unknown command; use help.");
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index].startsWith("--") ? args[index].slice(2) : "";
    if (!allowed[command].includes(key) || Object.hasOwn(options, key))
      throw fail("Unknown or duplicate option; use help.");
    if (key === "trusted-backup") options[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw fail("Missing option value.");
      options[key] = value;
    }
  }
  const required =
    command === "backup"
      ? ["defaults-file", "database", "output"]
      : command === "restore"
        ? ["defaults-file", "database", "backup", "trusted-backup"]
        : command === "status"
          ? ["defaults-file", "database"]
          : command === "verify"
            ? ["backup"]
            : [];
  if (required.some((key) => !options[key]))
    throw fail(
      "Missing required option; use help. Restore requires --trusted-backup.",
    );
  if (options.database && !/^[A-Za-z0-9_]{1,64}$/.test(options.database))
    throw fail(
      "Database must be a 1–64 character alphanumeric/underscore identifier.",
    );
  for (const [key, min, max] of [
    ["lock-timeout", 0, 300],
    ["timeout-seconds", 10, 86400],
  ]) {
    if (
      options[key] !== undefined &&
      (!/^\d+$/.test(options[key]) ||
        +options[key] < min ||
        +options[key] > max)
    )
      throw fail("Timeout outside supported range.");
  }
  return { command, options };
}

export async function requirePrivateFile(
  path,
  purpose = "Operator configuration",
) {
  if (!isAbsolute(path))
    throw fail("Operator configuration must use an absolute path.");
  const stat = await lstat(path).catch(() => {
    throw fail(`Cannot read private ${purpose.toLowerCase()}.`);
  });
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw fail(
      "Operator configuration must be an owned regular file with no group/other permissions (0600).",
    );
}

function clientEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "MYSQL_PWD",
    "MYSQL_HOST",
    "MYSQL_TCP_PORT",
    "MYSQL_UNIX_PORT",
    "MYSQL_HOME",
    "MYSQL_GROUP_SUFFIX",
    "MYSQL_TEST_LOGIN_FILE",
  ])
    delete env[key];
  return env;
}

function clientArguments(options) {
  return [
    `--defaults-file=${options["defaults-file"]}`,
    "--no-login-paths",
    "--default-character-set=utf8mb4",
  ];
}

// One connection owns the exact same advisory lock as artfi-migrate. Reconnection
// is disabled: a lost connection must never silently lose the lock and continue.
class Session {
  constructor(options, signal, onLost) {
    this.buffer = "";
    this.pending = null;
    this.failure = null;
    this.onLost = onLost;
    this.closing = false;
    this.child = spawn(
      options.mysql || "mysql",
      [
        ...clientArguments(options),
        "--connect-timeout=10",
        "--batch",
        "--raw",
        "--skip-column-names",
        "--unbuffered",
        "--skip-reconnect",
        `--database=${options.database}`,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: clientEnvironment(),
        signal,
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => {
      this.buffer += data;
      if (this.buffer.length > MAX_QUERY_BYTES)
        this.reject("MySQL metadata response exceeds the supported bound.");
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        const request = this.pending;
        if (!request) continue;
        request.bytes += Buffer.byteLength(line);
        if (request.bytes > MAX_QUERY_BYTES)
          return this.reject(
            "MySQL metadata response exceeds the supported bound.",
          );
        if (line === request.marker) {
          this.pending = null;
          request.resolve(request.rows);
        } else request.rows.push(line);
      }
    });
    // MySQL errors may contain row values or connection details; never echo them.
    this.child.stderr.resume();
    this.child.stdin.on("error", () =>
      this.reject("MySQL connection ended; no success was recorded."),
    );
    this.child.on("error", () =>
      this.reject("Cannot run MySQL client or operation timed out."),
    );
    this.closed = new Promise((resolveClosed) =>
      this.child.on("close", () => {
        this.reject(
          "MySQL connection ended; verify availability and private client configuration.",
        );
        resolveClosed();
      }),
    );
  }
  reject(message) {
    const first = !this.failure;
    this.failure ||= fail(message);
    this.pending?.reject(this.failure);
    this.pending = null;
    if (first && !this.closing) this.onLost();
  }
  query(sql) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(
        fail("Concurrent metadata requests are unsupported."),
      );
    return new Promise((resolveQuery, rejectQuery) => {
      const marker = `artfi_end_${randomUUID().replaceAll("-", "")}`;
      this.pending = {
        marker,
        rows: [],
        bytes: 0,
        resolve: resolveQuery,
        reject: rejectQuery,
      };
      this.child.stdin.write(`${sql};\nSELECT '${marker}';\n`);
    });
  }
  async json(sql) {
    try {
      return (await this.query(sql)).map((line) => JSON.parse(line));
    } catch (error) {
      if (this.failure) throw this.failure;
      throw fail("Invalid MySQL metadata response.");
    }
  }
  async close() {
    this.closing = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1000);
    await this.closed;
    clearTimeout(timer);
  }
}

const schemaQueries = {
  database:
    "SELECT JSON_OBJECT('characterSet',DEFAULT_CHARACTER_SET_NAME,'collation',DEFAULT_COLLATION_NAME) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()",
  tables:
    "SELECT JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE,'collation',TABLE_COLLATION,'options',CREATE_OPTIONS) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME",
  columns:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',COLUMN_NAME,'position',ORDINAL_POSITION,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT,'extra',EXTRA,'characterSet',CHARACTER_SET_NAME,'collation',COLLATION_NAME,'generated',GENERATION_EXPRESSION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION",
  indexes:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',INDEX_NAME,'nonUnique',NON_UNIQUE,'position',SEQ_IN_INDEX,'column',COLUMN_NAME,'prefix',SUB_PART,'type',INDEX_TYPE,'expression',EXPRESSION,'visible',IS_VISIBLE,'collation',COLLATION) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
  constraints:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',CONSTRAINT_NAME,'type',CONSTRAINT_TYPE,'enforced',ENFORCED) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME",
  keys: "SELECT JSON_OBJECT('table',TABLE_NAME,'name',CONSTRAINT_NAME,'column',COLUMN_NAME,'position',ORDINAL_POSITION,'referenceTable',REFERENCED_TABLE_NAME,'referenceColumn',REFERENCED_COLUMN_NAME,'referencePosition',POSITION_IN_UNIQUE_CONSTRAINT) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION",
  foreignKeys:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',CONSTRAINT_NAME,'referenceTable',REFERENCED_TABLE_NAME,'update',UPDATE_RULE,'delete',DELETE_RULE,'match',MATCH_OPTION) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME",
  checks:
    "SELECT JSON_OBJECT('name',CONSTRAINT_NAME,'clause',CHECK_CLAUSE) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() ORDER BY CONSTRAINT_NAME",
};

async function objectCounts(session) {
  return (
    await session.json(
      "SELECT JSON_OBJECT('tables',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()),'unsupportedTables',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_TYPE<>'BASE TABLE' OR ENGINE<>'InnoDB')),'triggers',(SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()),'routines',(SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()),'events',(SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()))",
    )
  )[0];
}

async function snapshot(session) {
  const counts = await objectCounts(session);
  if (
    counts.unsupportedTables ||
    counts.triggers ||
    counts.routines ||
    counts.events
  )
    throw fail(
      "Unsupported schema: backup requires only InnoDB base tables and no views, triggers, routines or events; nothing was omitted silently.",
    );
  const schema = {};
  for (const [key, sql] of Object.entries(schemaQueries))
    schema[key] = await session.json(sql);
  if (!schema.tables.some((table) => table.name === "artfi_schema_migrations"))
    throw fail(
      "Migration ledger is missing; backup requires an installer-managed application database.",
    );
  const ledger = await session.json(
    "SELECT JSON_OBJECT('name',name,'checksum',checksum,'dirty',dirty,'appliedAt',DATE_FORMAT(applied_at,'%Y-%m-%dT%H:%i:%s.%fZ')) FROM artfi_schema_migrations ORDER BY name",
  );
  if (
    !ledger.length ||
    ledger.some(
      (item) =>
        item.dirty !== 0 ||
        !/^[a-f0-9]{64}$/.test(item.checksum) ||
        !item.appliedAt,
    )
  )
    throw fail(
      "Migration ledger is empty, dirty or invalid; recover the schema before backup.",
    );
  return { schema, ledger, schemaSha256: hash(JSON.stringify(schema)) };
}

async function lock(session, options) {
  await session.query("SET SESSION time_zone='+00:00'");
  const rows = await session.query(
    `SELECT GET_LOCK(CONCAT('artfi-schema:', DATABASE()), ${options["lock-timeout"] || 30})`,
  );
  if (rows[0] !== "1")
    throw fail(
      "Cannot acquire schema migration lock; retry after the other schema operation finishes.",
    );
}

async function assertLock(session) {
  if (
    (
      await session.query(
        "SELECT IS_USED_LOCK(CONCAT('artfi-schema:', DATABASE()))=CONNECTION_ID()",
      )
    )[0] !== "1"
  )
    throw fail("Schema migration lock was lost; no success was recorded.");
}

async function runClient(binary, args, { signal, input, output }) {
  const child = spawn(binary, args, {
    stdio: [input ? input.fd : "ignore", output ? output.fd : "ignore", "pipe"],
    env: clientEnvironment(),
    signal,
  });
  child.stderr.resume();
  const finished = new Promise((resolveRun, rejectRun) => {
    child.on("error", () =>
      rejectRun(fail("MySQL client unavailable or operation timed out.")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(
            fail(
              "MySQL client failed; inspect server availability and privileges privately. A partial restore must not be reused.",
            ),
          ),
    );
  });
  try {
    await finished;
  } catch {
    child.kill("SIGTERM");
    await finished.catch(() => {});
    throw fail(
      "MySQL client operation failed; no success was recorded. A partial restore must not be reused.",
    );
  }
}

async function runLockedClient(session, binary, args, io) {
  // mysql is a synchronous command-line client: while idle on stdin it may not
  // notice that the server killed its connection. Poll the held lock during a
  // long dump/import so lock loss aborts both operations promptly.
  let pending = null;
  let problem = null;
  const heartbeat = setInterval(() => {
    if (pending || problem) return;
    pending = assertLock(session)
      .catch((error) => {
        problem = error;
        session.reject(
          "Schema migration lock was lost; no success was recorded.",
        );
      })
      .finally(() => {
        pending = null;
      });
  }, 1000);
  try {
    await runClient(binary, args, io);
  } finally {
    clearInterval(heartbeat);
    if (pending) await pending;
  }
  if (problem) throw problem;
}

async function digestFile(handle) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of handle.createReadStream({
    start: 0,
    autoClose: false,
  })) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}

async function privateBackupDirectory(directory) {
  const stat = await lstat(directory).catch(() => {
    throw fail("Backup directory is missing.");
  });
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw fail(
      "Backup directory must be owned and private (0700), and must not be a symlink.",
    );
}

async function openBackup(directory) {
  await privateBackupDirectory(directory);
  await requirePrivateFile(join(directory, MANIFEST_FILE), "backup manifest");
  let manifest;
  try {
    const stat = await lstat(join(directory, MANIFEST_FILE));
    if (stat.size > MAX_QUERY_BYTES) throw fail("too large");
    manifest = JSON.parse(
      await readFile(join(directory, MANIFEST_FILE), "utf8"),
    );
  } catch {
    throw fail("Invalid or missing backup manifest.");
  }
  if (
    manifest.format !== FORMAT ||
    manifest.completed !== true ||
    manifest.file !== SQL_FILE ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    !manifest.schema ||
    !Array.isArray(manifest.ledger) ||
    !manifest.ledger.length ||
    manifest.schemaSha256 !== hash(JSON.stringify(manifest.schema))
  )
    throw fail("Backup manifest format or schema checksum is invalid.");
  await requirePrivateFile(join(directory, SQL_FILE), "backup SQL file");
  const handle = await open(
    join(directory, SQL_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const actual = await digestFile(handle);
    if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes)
      throw fail("Backup checksum or size mismatch; restore refused.");
    return { manifest, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function withSession(options, run) {
  await requirePrivateFile(options["defaults-file"]);
  const aborter = new AbortController();
  const timer = setTimeout(
    () => aborter.abort(),
    +(options["timeout-seconds"] || 3600) * 1000,
  );
  const interrupt = () => aborter.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const session = new Session(options, aborter.signal, () => aborter.abort());
  try {
    return await run(session, aborter.signal);
  } finally {
    await session.close();
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
}

export async function backup(options) {
  const directory = resolve(options.output);
  return withSession(options, async (session, signal) => {
    await lock(session, options);
    const version = (await session.query("SELECT VERSION()"))[0];
    if (!/^8\./.test(version))
      throw fail(
        "This backup format is verified for MySQL 8; unsupported server version.",
      );
    const before = await snapshot(session);
    // mkdir is intentionally exclusive. Never overwrite, mix, or clean up an
    // existing backup; incomplete output retains evidence but has no manifest.
    await mkdir(directory, { mode: 0o700 });
    const handle = await open(
      join(directory, `${SQL_FILE}.partial`),
      "wx",
      0o600,
    );
    try {
      await runLockedClient(
        session,
        options.mysqldump || "mysqldump",
        [
          ...clientArguments(options),
          "--single-transaction",
          "--quick",
          "--skip-lock-tables",
          "--no-tablespaces",
          "--set-gtid-purged=OFF",
          "--skip-add-drop-table",
          "--skip-add-locks",
          "--skip-disable-keys",
          "--skip-comments",
          "--skip-triggers",
          "--hex-blob",
          "--tz-utc",
          "--column-statistics=0",
          "--no-create-db",
          options.database,
        ],
        {
          signal,
          output: handle,
        },
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertLock(session);
    const after = await snapshot(session);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw fail(
        "Schema or migration ledger changed during backup; discard this incomplete snapshot.",
      );
    const dump = await open(join(directory, `${SQL_FILE}.partial`), "r");
    let digest;
    try {
      digest = await digestFile(dump);
    } finally {
      await dump.close();
    }
    await rename(
      join(directory, `${SQL_FILE}.partial`),
      join(directory, SQL_FILE),
    );
    const manifest = {
      format: FORMAT,
      completed: true,
      createdAt: new Date().toISOString(),
      sourceDatabase: options.database,
      serverVersion: version,
      file: SQL_FILE,
      ...digest,
      ...before,
      consistency: "single-transaction/InnoDB; artfi-schema advisory lock",
      authenticity:
        "SHA-256 detects corruption only. Accept only a trusted operator-controlled backup.",
    };
    const metadata = await open(
      join(directory, `${MANIFEST_FILE}.partial`),
      "wx",
      0o600,
    );
    try {
      await metadata.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    await rename(
      join(directory, `${MANIFEST_FILE}.partial`),
      join(directory, MANIFEST_FILE),
    );
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return {
      command: "backup",
      result: "PASSED",
      tables: before.schema.tables.length,
      migrations: before.ledger.length,
      bytes: digest.bytes,
      sha256: digest.sha256,
      schemaSha256: before.schemaSha256,
    };
  });
}

export async function verify(options) {
  const { manifest, handle } = await openBackup(resolve(options.backup));
  await handle.close();
  return {
    command: "verify",
    result: "PASSED",
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    schemaSha256: manifest.schemaSha256,
    authenticityVerified: false,
  };
}

export async function restore(options) {
  if (!options["trusted-backup"])
    throw fail(
      "Restore requires --trusted-backup after verifying origin through your trusted backup storage.",
    );
  const { manifest, handle } = await openBackup(resolve(options.backup));
  try {
    return await withSession(options, async (session, signal) => {
      await lock(session, options);
      const counts = await objectCounts(session);
      if (counts.tables || counts.triggers || counts.routines || counts.events)
        throw fail(
          "Restore target is not empty; provision a separate empty database. Nothing was dropped or overwritten.",
        );
      const database = await session.json(schemaQueries.database);
      if (JSON.stringify(database) !== JSON.stringify(manifest.schema.database))
        throw fail(
          "Empty restore database character set/collation differs from backup; provision a matching database.",
        );
      // Consume the same open file that was checksummed, not a reopened filename.
      // Trust is still required: checksum integrity is not SQL authenticity.
      await runLockedClient(
        session,
        options.mysql || "mysql",
        [
          ...clientArguments(options),
          "--connect-timeout=10",
          "--batch",
          "--binary-mode",
          "--skip-reconnect",
          `--database=${options.database}`,
        ],
        {
          signal,
          input: handle,
        },
      );
      await assertLock(session);
      const after = await snapshot(session);
      if (
        after.schemaSha256 !== manifest.schemaSha256 ||
        JSON.stringify(after.ledger) !== JSON.stringify(manifest.ledger)
      )
        throw fail(
          "Restored schema or migration ledger does not match backup. Keep this database isolated; do not activate it.",
        );
      return {
        command: "restore",
        result: "PASSED",
        tables: after.schema.tables.length,
        migrations: after.ledger.length,
        sha256: manifest.sha256,
        schemaSha256: after.schemaSha256,
        activated: false,
      };
    });
  } finally {
    await handle.close();
  }
}

export async function status(options) {
  return withSession(options, async (session) => {
    const [server] = await session.json(
      "SELECT JSON_OBJECT('version',VERSION(),'serverId',@@server_id,'readOnly',@@read_only,'superReadOnly',@@super_read_only,'gtidMode',@@gtid_mode,'logBin',@@log_bin,'binlogFormat',@@binlog_format)",
    );
    // Performance Schema exposes replica status without printing connection
    // credentials, source hostnames, executed queries or replica error text.
    const connections = await session.json(
      "SELECT JSON_OBJECT('channel',CHANNEL_NAME,'state',SERVICE_STATE,'errorNumber',LAST_ERROR_NUMBER) FROM performance_schema.replication_connection_status ORDER BY CHANNEL_NAME",
    );
    const appliers = await session.json(
      "SELECT JSON_OBJECT('channel',CHANNEL_NAME,'state',SERVICE_STATE) FROM performance_schema.replication_applier_status ORDER BY CHANNEL_NAME",
    );
    const workers = await session.json(
      "SELECT JSON_OBJECT('channel',CHANNEL_NAME,'worker',WORKER_ID,'state',SERVICE_STATE,'errorNumber',LAST_ERROR_NUMBER) FROM performance_schema.replication_applier_status_by_worker ORDER BY CHANNEL_NAME,WORKER_ID",
    );
    const replicationHealthy = connections.length
      ? connections.every(
          (row) => row.state === "ON" && row.errorNumber === 0,
        ) &&
        appliers.length === connections.length &&
        appliers.every((row) => row.state === "ON") &&
        workers.every((row) => row.state === "ON" && row.errorNumber === 0)
      : null;
    const degraded =
      replicationHealthy === false ||
      (server.readOnly === 1 && replicationHealthy === null);
    return {
      command: "status",
      result: degraded ? "DEGRADED" : "PASSED",
      connected: true,
      server,
      connections,
      appliers,
      workers,
      replicationHealthy,
      automaticPromotion: false,
      freshness:
        "Thread state alone does not prove catch-up. Verify the required source GTID position before using a replica.",
    };
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "help")
    return "ArtFi MySQL recovery (Node + official MySQL 8 mysql/mysqldump clients)\nbackup --defaults-file /private/client.cnf --database NAME --output /private/NEW_DIRECTORY\nverify --backup /private/BACKUP_DIRECTORY\nrestore --defaults-file /private/client.cnf --database EMPTY_NAME --backup /private/BACKUP_DIRECTORY --trusted-backup\nstatus --defaults-file /private/client.cnf --database NAME\nOptional: --mysql PATH; backup: --mysqldump PATH; database operations: --timeout-seconds 10..86400; backup/restore: --lock-timeout 0..300.\nNo credential arguments, database creation/deletion, role changes, promotion, activation, remote upload or retention deletion.\n";
  return { backup, restore, verify, status }[command](options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((result) => {
      process.stdout.write(
        typeof result === "string" ? result : `${JSON.stringify(result)}\n`,
      );
      if (result.result === "DEGRADED") process.exitCode = 2;
    })
    .catch((error) => {
      // Filesystem errors can embed confidential paths. Expose only our deliberate
      // operational messages, never native errors, SQL, configuration or row data.
      process.stderr.write(
        `Recovery error: ${error.code ? "File operation failed; check private paths, permissions and available space." : error.message}\n`,
      );
      process.exitCode = 1;
    });
}
