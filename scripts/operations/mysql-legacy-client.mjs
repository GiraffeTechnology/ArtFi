// Internal client primitives for the separate, explicit legacy adoption procedure.
// The installed migrator and mysql-recovery.mjs remain unchanged.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
const MAX_QUERY_BYTES = 32 * 1024 * 1024;
const fail = (message) => new Error(message);
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
        "--binary-mode",
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
    "SELECT JSON_OBJECT('name',TABLE_NAME,'engine',ENGINE,'collation',TABLE_COLLATION,'options',CREATE_OPTIONS,'rowFormat',ROW_FORMAT,'comment',TABLE_COMMENT) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME",
  columns:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',COLUMN_NAME,'position',ORDINAL_POSITION,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT,'extra',EXTRA,'characterSet',CHARACTER_SET_NAME,'collation',COLLATION_NAME,'generated',GENERATION_EXPRESSION,'comment',COLUMN_COMMENT,'srsId',SRS_ID) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION",
  indexes:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',INDEX_NAME,'nonUnique',NON_UNIQUE,'position',SEQ_IN_INDEX,'column',COLUMN_NAME,'prefix',SUB_PART,'type',INDEX_TYPE,'expression',EXPRESSION,'visible',IS_VISIBLE,'collation',COLLATION,'nullable',NULLABLE,'comment',INDEX_COMMENT) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",
  constraints:
    "SELECT JSON_OBJECT('table',TABLE_NAME,'name',CONSTRAINT_NAME,'type',CONSTRAINT_TYPE,'enforced',ENFORCED) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME",
  keys: "SELECT JSON_OBJECT('table',TABLE_NAME,'name',CONSTRAINT_NAME,'column',COLUMN_NAME,'position',ORDINAL_POSITION,'referenceTable',REFERENCED_TABLE_NAME,'referenceColumn',REFERENCED_COLUMN_NAME,'referencePosition',POSITION_IN_UNIQUE_CONSTRAINT,'referenceLocal',REFERENCED_TABLE_SCHEMA IS NULL OR REFERENCED_TABLE_SCHEMA=DATABASE()) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION",
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

export {
  schemaQueries,
  objectCounts,
  lock,
  assertLock,
  runLockedClient,
  digestFile,
  withSession,
  clientArguments,
};
