#!/usr/bin/env node
// Explicit, bounded compatibility bridge for legacy ArtFi migration ledgers.
// Never import this module from the installer or call it automatically.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  schemaQueries,
  objectCounts,
  lock,
  assertLock,
  runLockedClient,
  digestFile,
  withSession,
  clientArguments,
  requirePrivateFile,
} from "./mysql-legacy-client.mjs";

const LEGACY = "artfi_deployment_migrations";
const CURRENT = "artfi_schema_migrations";
const FORMAT = "artfi-legacy-adoption-v1";
const HERE = dirname(fileURLToPath(import.meta.url));
export const OFFICIAL = [
  [
    "000001_stage1_catalog.up.sql",
    "139e8255c677db0c9042a264d5732b0fc92f13fe22353f50cf811ea5b15c62db",
  ],
  [
    "000002_stage2_rwa_mint.up.sql",
    "c10c5ceaeb9532c034a8971819d9278fcd41942fb5a4b27b8e157bb31156319b",
  ],
  [
    "000003_stage3_vault_fractional.up.sql",
    "1f6387ad59b989b0298442151e076958704fb9ff74750d454bdfe77f338871ef",
  ],
  [
    "000004_stage4_market_governance.up.sql",
    "ca3d924e20c2e645dccd820ea5eb908af50f1b9abe358ac4060e31a959d2aa37",
  ],
  [
    "000005_stage6_compliance_operations.up.sql",
    "426978dc801197b71058e55f3c0da2eb37428e9f75ba2db8922db653505f0052",
  ],
  [
    "000006_dao_rwa_governance.up.sql",
    "172c9ceb0f17ae887998b162ffcefb7807094f4b9baa69483716aef81e9672b5",
  ],
  [
    "000007_external_trade_orchestration.up.sql",
    "ef47667bf90e6a5873d1d73e63fc08e831a6c0f2b47ce786ea2b08ea852f738b",
  ],
  [
    "000008_hoodi_test_chain.up.sql",
    "f1ffbc894ff7de9786321dab3c581ae19c9394473e2b53e73683f8517ac93619",
  ],
  [
    "000009_native_signed_orders.up.sql",
    "4f3c20b2a366440372dffd9371121c36f3354c9651943c4f154fda76c50b229e",
  ],
  [
    "000010_wallet_user_sessions.up.sql",
    "22a890d4749c33e65c9f97e0a6b8edce7aa9c3ba68a50adfa4a0bf314a7a0a66",
  ],
].map(([name, checksum]) => ({ name, checksum }));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const stable = (value) => JSON.stringify(canonical(value));
const equal = (a, b) => stable(a) === stable(b);
const fail = (message) => new Error(message);
const ident = (value) => "`" + String(value).replaceAll("`", "``") + "`";
// Hex string literals avoid SQL mode and escaping ambiguities. Never print SQL.
const literal = (value) =>
  value === null
    ? "NULL"
    : `CONVERT(X'${Buffer.from(String(value)).toString("hex")}' USING utf8mb4)`;
const shaPattern = /^[a-f0-9]{64}$/;
const safeName = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value);

export function parseArguments(argv) {
  const [command = "help", ...args] = argv;
  const common = [
    "defaults-file",
    "database",
    "mysql",
    "lock-timeout",
    "timeout-seconds",
  ];
  const allowed = {
    help: [],
    reference: [
      ...common,
      "isolated-defaults-file",
      "isolated-database",
      "isolated-target",
      "migrations",
      "output",
    ],
    inspect: [...common, "migrations", "reference", "output"],
    backup: [...common, "inspect", "mysqldump", "output"],
    "restore-check": [
      ...common,
      "backup",
      "mysqldump",
      "trusted-backup",
      "isolated-target",
      "output",
    ],
    plan: ["inspect", "backup", "restore-evidence", "output"],
    apply: [
      ...common,
      "migrations",
      "plan",
      "plan-sha256",
      "backup",
      "approve-ledger-only",
      "maintenance-confirmed",
    ],
  };
  if (!Object.hasOwn(allowed, command))
    throw fail("Unknown command; use help.");
  const options = {};
  const flags = new Set([
    "isolated-target",
    "trusted-backup",
    "approve-ledger-only",
    "maintenance-confirmed",
  ]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (!allowed[command].includes(key) || Object.hasOwn(options, key))
      throw fail("Unknown or duplicate option; use help.");
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw fail("Missing option value.");
      options[key] = value;
    }
  }
  const required = {
    help: [],
    reference: [
      "defaults-file",
      "database",
      "isolated-defaults-file",
      "isolated-database",
      "isolated-target",
      "migrations",
      "output",
    ],
    inspect: ["defaults-file", "database", "migrations", "reference", "output"],
    backup: ["defaults-file", "database", "inspect", "output"],
    "restore-check": [
      "defaults-file",
      "database",
      "backup",
      "trusted-backup",
      "isolated-target",
      "output",
    ],
    plan: ["inspect", "backup", "restore-evidence", "output"],
    apply: [
      "defaults-file",
      "database",
      "migrations",
      "plan",
      "plan-sha256",
      "backup",
      "approve-ledger-only",
      "maintenance-confirmed",
    ],
  };
  if (required[command].some((key) => !options[key]))
    throw fail(
      "Missing required option or explicit acknowledgement; use help.",
    );
  for (const key of ["database", "isolated-database"])
    if (options[key] && !safeName(options[key]))
      throw fail("Unsafe database identifier.");
  for (const [key, min, max] of [
    ["lock-timeout", 0, 300],
    ["timeout-seconds", 10, 86400],
  ])
    if (
      options[key] !== undefined &&
      (!/^\d+$/.test(options[key]) ||
        +options[key] < min ||
        +options[key] > max)
    )
      throw fail("Timeout outside supported range.");
  return { command, options };
}
async function sourceFiles(directory) {
  const files = [];
  for (const migration of OFFICIAL) {
    const body = await readFile(join(resolve(directory), migration.name));
    if (hash(body) !== migration.checksum)
      throw fail(
        "Official historical migration checksum mismatch; no adoption is permitted.",
      );
    files.push({ ...migration, body: body.toString("utf8") });
  }
  return files;
}
async function toolHashes() {
  const result = {};
  for (const name of ["mysql-legacy-adoption.mjs", "mysql-legacy-client.mjs"])
    result[name] = hash(await readFile(join(HERE, name)));
  return result;
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw fail(
      "Artifacts require an owned private directory (0700), not a symlink.",
    );
}
async function readJSON(path, kind) {
  const absolute = resolve(path);
  await requirePrivateFile(absolute, "adoption evidence");
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if ((await handle.stat()).size > 32 * 1024 * 1024)
      throw fail("Evidence file exceeds supported size.");
    const bytes = await handle.readFile();
    let value;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw fail("Invalid adoption evidence JSON.");
    }
    if (
      value.format !== FORMAT ||
      value.kind !== kind ||
      value.completed !== true
    )
      throw fail("Incomplete or incompatible adoption evidence.");
    return { value, sha256: hash(bytes) };
  } finally {
    await handle.close();
  }
}
async function writeJSON(path, kind, payload) {
  const absolute = resolve(path);
  await privateDirectory(dirname(absolute));
  const value = {
    format: FORMAT,
    kind,
    completed: true,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  const bytes = Buffer.from(stable(value) + "\n");
  const handle = await open(absolute, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    command: kind,
    result: "PASSED",
    sha256: hash(bytes),
    writesSourceBusinessData: false,
  };
}
async function identity(session) {
  const [result] = await session.json(
    "SELECT JSON_OBJECT('serverUuid',@@server_uuid,'database',DATABASE(),'version',VERSION(),'lowerCaseTableNames',@@lower_case_table_names) ",
  );
  if (!/^8\./.test(result.version))
    throw fail("Only official MySQL 8 is supported.");
  return result;
}
async function schema(session, excluded = []) {
  const counts = await objectCounts(session);
  const [partitioned] = await session.query(
    "SELECT COUNT(*) FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND PARTITION_NAME IS NOT NULL",
  );
  if (
    counts.unsupportedTables ||
    counts.triggers ||
    counts.routines ||
    counts.events ||
    partitioned !== "0"
  )
    throw fail(
      "Unsupported schema object: only nonpartitioned InnoDB base tables, without views, triggers, routines or events, are supported.",
    );
  const result = {};
  for (const [key, sql] of Object.entries(schemaQueries))
    result[key] = await session.json(sql);
  if (
    result.keys.some(
      (key) => key.referenceLocal !== 1 && key.referenceLocal !== true,
    )
  )
    throw fail("Cross-database foreign keys are unsupported.");
  const excludedConstraints = new Set(
    result.constraints
      .filter((row) => excluded.includes(row.table))
      .map((row) => row.name),
  );
  for (const [key, rows] of Object.entries(result))
    result[key] = rows.filter((row) =>
      key === "tables"
        ? !excluded.includes(row.name)
        : key === "checks"
          ? !excludedConstraints.has(row.name)
          : !excluded.includes(row.table),
    );
  return result;
}
async function legacy(session) {
  const rows = await session.json(
    `SELECT JSON_OBJECT('version',CAST(version AS CHAR),'sourceSha',CAST(source_sha AS CHAR),'checksum',CAST(sql_sha256 AS CHAR),'appliedAt',DATE_FORMAT(applied_at,'%Y-%m-%dT%H:%i:%s.%fZ')) FROM ${LEGACY} ORDER BY BINARY CAST(version AS CHAR)`,
  );
  if (
    rows.length !== 10 ||
    new Set(rows.map((row) => row.version)).size !== 10 ||
    new Set(rows.map((row) => row.checksum)).size !== 10 ||
    rows.some(
      (row) =>
        typeof row.version !== "string" ||
        !row.version.length ||
        !shaPattern.test(row.checksum) ||
        !/^[a-f0-9]{40}$/.test(row.sourceSha) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.appliedAt),
    )
  )
    throw fail(
      "Legacy ledger must contain exactly ten unique, valid historical records.",
    );
  // Exact checksum bijection establishes names; legacy version syntax is never guessed.
  if (
    OFFICIAL.some((file) => !rows.some((row) => row.checksum === file.checksum))
  )
    throw fail(
      "Legacy ledger is not the exact official first-ten checksum set.",
    );
  return rows;
}
async function capture(session, excluded = []) {
  const id = await identity(session);
  const fullSchema = await schema(session, excluded);
  if (!fullSchema.tables.some((table) => table.name === LEGACY))
    throw fail("Legacy ledger is missing.");
  const oldRows = await legacy(session);
  return {
    identity: id,
    schema: fullSchema,
    schemaSha256: hash(stable(fullSchema)),
    legacyRows: oldRows,
    legacyRowsSha256: hash(stable(oldRows)),
  };
}
async function validateData(session, metadata) {
  // Actual relational constraints only. Historical payload hashes are application
  // values, not an asserted canonical JSON hash; do not invent that invariant.
  let checked = 0;
  for (const constraint of metadata.constraints) {
    if (constraint.type === "CHECK") {
      const check = metadata.checks.find((row) => row.name === constraint.name);
      if (!check) throw fail("CHECK definition is missing.");
      // MySQL 8 CHECK_CLAUSE quotes string delimiters as backslash-quote.
      // The pinned 1–10 clauses contain no escaped characters inside literals.
      // Decode only those delimiters; fail closed on other escaping.
      const expression = check.clause.replace(/\\+'/g, "'");
      if (expression.includes("\\"))
        throw fail("Unsupported CHECK expression escaping.");
      const [bad] = await session.query(
        `SELECT EXISTS(SELECT 1 FROM ${ident(constraint.table)} WHERE NOT (${expression}) LIMIT 1)`,
      );
      if (bad !== "0")
        throw fail(
          "Existing data violates a declared CHECK constraint; adoption refused.",
        );
      checked++;
    }
    if (constraint.type === "FOREIGN KEY") {
      const keys = metadata.keys.filter(
        (row) => row.table === constraint.table && row.name === constraint.name,
      );
      const present = keys
        .map((row) => `c.${ident(row.column)} IS NOT NULL`)
        .join(" AND ");
      const matches = keys
        .map((row) => `p.${ident(row.referenceColumn)}=c.${ident(row.column)}`)
        .join(" AND ");
      const [bad] = await session.query(
        `SELECT EXISTS(SELECT 1 FROM ${ident(constraint.table)} c WHERE ${present} AND NOT EXISTS(SELECT 1 FROM ${ident(keys[0].referenceTable)} p WHERE ${matches}) LIMIT 1)`,
      );
      if (bad !== "0")
        throw fail(
          "Existing data violates a declared foreign key; adoption refused.",
        );
      checked++;
    }
  }
  for (const table of metadata.tables) {
    const indexes = metadata.indexes.filter((row) => row.table === table.name);
    if (!indexes.some((row) => row.name === "PRIMARY"))
      throw fail("Deterministic backup requires a primary key on every table.");
    for (const name of new Set(
      indexes.filter((row) => row.nonUnique === 0).map((row) => row.name),
    )) {
      const keys = indexes.filter((row) => row.name === name);
      const expressions = keys.map((row) =>
        row.expression
          ? `(${row.expression})`
          : row.prefix
            ? `LEFT(${ident(row.column)},${Number(row.prefix)})`
            : ident(row.column),
      );
      const [bad] = await session.query(
        `SELECT EXISTS(SELECT 1 FROM ${ident(table.name)} WHERE ${expressions.map((expr) => `${expr} IS NOT NULL`).join(" AND ")} GROUP BY ${expressions.join(",")} HAVING COUNT(*)>1 LIMIT 1)`,
      );
      if (bad !== "0")
        throw fail(
          "Existing data violates a declared unique index; adoption refused.",
        );
      checked++;
    }
  }
  return {
    result: "PASSED",
    constraintsChecked: checked,
    payloadHashEqualityAsserted: false,
  };
}
function compareInspection(current, inspection) {
  if (!equal(current, inspection.snapshot))
    throw fail(
      "Database identity, schema or legacy ledger drifted from inspection; start a new review.",
    );
}
async function createEmpty(session, name, database) {
  const [exists] = await session.query(
    `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${literal(name)}`,
  );
  if (exists !== "0")
    throw fail(
      "Isolated target database already exists; choose a fresh name. Nothing was dropped.",
    );
  if (!/^artfi_adoption_[A-Za-z0-9_]+$/.test(name))
    throw fail("Isolated database names must start with artfi_adoption_.");
  const { characterSet, collation } = database[0];
  if (!/^[a-z0-9_]+$/.test(characterSet) || !/^[a-z0-9_]+$/.test(collation))
    throw fail("Unsupported database character set metadata.");
  await session.query(
    `CREATE DATABASE ${ident(name)} CHARACTER SET ${characterSet} COLLATE ${collation}`,
  );
  await session.query(`USE ${ident(name)}`);
  await lock(session, {});
}
export async function reference(options) {
  if (!options["isolated-target"])
    throw fail(
      "Reference construction requires an explicitly isolated target.",
    );
  const files = await sourceFiles(options.migrations);
  const source = await withSession(options, async (session) => {
    await lock(session, options);
    return {
      identity: await identity(session),
      database: await session.json(schemaQueries.database),
    };
  });
  const target = {
    ...options,
    "defaults-file": options["isolated-defaults-file"],
    database: "mysql",
  };
  return withSession(target, async (session) => {
    const isolated = await identity(session);
    if (isolated.serverUuid === source.identity.serverUuid)
      throw fail(
        "Reference server must be a distinct disposable MySQL instance.",
      );
    if (
      isolated.version !== source.identity.version ||
      isolated.lowerCaseTableNames !== source.identity.lowerCaseTableNames
    )
      throw fail(
        "Reference server version and identifier case settings must match source.",
      );
    await createEmpty(session, options["isolated-database"], source.database);
    for (const file of files) await session.query(file.body);
    const metadata = await schema(session);
    return writeJSON(options.output, "reference", {
      sourceIdentity: source.identity,
      isolatedIdentity: await identity(session),
      schema: metadata,
      schemaSha256: hash(stable(metadata)),
      migrations: OFFICIAL,
      toolHashes: await toolHashes(),
    });
  });
}
export async function inspect(options) {
  await sourceFiles(options.migrations);
  const { value: ref, sha256: referenceSha256 } = await readJSON(
    options.reference,
    "reference",
  );
  if (
    !equal(ref.migrations, OFFICIAL) ||
    !equal(ref.toolHashes, await toolHashes()) ||
    ref.schemaSha256 !== hash(stable(ref.schema))
  )
    throw fail("Reference provenance/checksum mismatch.");
  return withSession(options, async (session) => {
    await lock(session, options);
    const snapshot = await capture(session);
    if (snapshot.schema.tables.some((table) => table.name === CURRENT))
      throw fail(
        "Current ledger already exists; adoption inspection does not replace it.",
      );
    if (
      !equal(snapshot.identity, ref.sourceIdentity) ||
      snapshot.identity.serverUuid === ref.isolatedIdentity.serverUuid
    )
      throw fail("Reference was built for a different source identity.");
    const business = await schema(session, [LEGACY]);
    if (!equal(business, ref.schema)) {
      await writeJSON(options.output, "inspection-refused", {
        snapshot,
        referenceSchema: ref.schema,
        referenceSha256,
        reason: "Full business schema differs from official migrations 1–10",
        sourceWrites: false,
      });
      throw fail(
        "Full business schema differs from official migrations 1–10; private comparison saved, adoption refused.",
      );
    }
    const dataAudit = await validateData(session, snapshot.schema);
    await assertLock(session);
    if (!equal(snapshot, await capture(session)))
      throw fail("Schema or ledger changed during inspection.");
    return writeJSON(options.output, "inspect", {
      snapshot,
      reference: ref,
      referenceSha256,
      migrations: OFFICIAL,
      toolHashes: await toolHashes(),
      dataAudit,
      mappingMethod:
        "exact distinct SQL checksum bijection; legacy versions preserved verbatim",
      sourceWrites: false,
    });
  });
}
function dumpArgs(options, dataOnly = false) {
  return [
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
    "--skip-extended-insert",
    "--order-by-primary",
    ...(dataOnly ? ["--no-create-info"] : []),
    options.database,
  ];
}
async function dataDigest(handle) {
  const digest = createHash("sha256");
  let rows = 0;
  const lines = createInterface({
    input: handle.createReadStream({ start: 0, autoClose: false }),
    crlfDelay: Infinity,
  });
  for await (const line of lines)
    if (line.startsWith("INSERT INTO ")) {
      digest.update(line + "\n");
      rows++;
    }
  return {
    sha256: digest.digest("hex"),
    rows,
    method: "ordered single-row INSERT stream from the same consistent dump",
  };
}
async function digestSQL(path) {
  await requirePrivateFile(path, "backup SQL");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return { ...(await digestFile(handle)), data: await dataDigest(handle) };
  } finally {
    await handle.close();
  }
}
async function backupEvidence(path) {
  const directory = resolve(path);
  await privateDirectory(directory);
  const evidence = await readJSON(join(directory, "manifest.json"), "backup");
  const actual = await digestSQL(join(directory, "database.sql"));
  if (!equal(actual, evidence.value.dump))
    throw fail("Backup bytes or data digest changed; adoption refused.");
  return { ...evidence, directory };
}
export async function backup(options) {
  const inspected = await readJSON(options.inspect, "inspect");
  return withSession(options, async (session, signal) => {
    await lock(session, options);
    const before = await capture(session);
    compareInspection(before, inspected.value);
    const directory = resolve(options.output);
    await privateDirectory(dirname(directory));
    await mkdir(directory, { mode: 0o700 });
    const part = join(directory, "database.sql.partial");
    const handle = await open(part, "wx", 0o600);
    try {
      await runLockedClient(
        session,
        options.mysqldump || "mysqldump",
        dumpArgs(options),
        { signal, output: handle },
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertLock(session);
    compareInspection(await capture(session), inspected.value);
    const dump = await digestSQL(part);
    if (dump.bytes < 1) throw fail("Backup is empty.");
    await rename(part, join(directory, "database.sql"));
    return writeJSON(join(directory, "manifest.json"), "backup", {
      snapshot: before,
      inspectionSha256: inspected.sha256,
      dump,
      toolHashes: await toolHashes(),
      consistency:
        "single-transaction/InnoDB; artfi-schema advisory lock; no comparison to a racing source-data read",
      authenticity: "Integrity only. Keep in trusted private operator storage.",
    });
  });
}
export async function restoreCheck(options) {
  if (!options["trusted-backup"] || !options["isolated-target"])
    throw fail(
      "Restore requires trusted backup and explicitly isolated target acknowledgements.",
    );
  const evidence = await backupEvidence(options.backup);
  const manifest = evidence.value;
  return withSession(
    { ...options, database: "mysql" },
    async (session, signal) => {
      const isolated = await identity(session);
      if (isolated.serverUuid === manifest.snapshot.identity.serverUuid)
        throw fail(
          "Restore test must use a distinct disposable MySQL instance.",
        );
      if (
        isolated.version !== manifest.snapshot.identity.version ||
        isolated.lowerCaseTableNames !==
          manifest.snapshot.identity.lowerCaseTableNames
      )
        throw fail(
          "Restore server version and case settings must match source.",
        );
      await createEmpty(
        session,
        options.database,
        manifest.snapshot.schema.database,
      );
      const input = await open(
        join(evidence.directory, "database.sql"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        // Rehash the SAME open handle consumed by mysql, avoiding path substitution.
        if (
          !equal(await digestFile(input), {
            sha256: manifest.dump.sha256,
            bytes: manifest.dump.bytes,
          })
        )
          throw fail("Backup changed before restore.");
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
          { signal, input },
        );
      } finally {
        await input.close();
      }
      await assertLock(session);
      const restored = await capture(session);
      if (
        !equal(restored.schema, manifest.snapshot.schema) ||
        !equal(restored.legacyRows, manifest.snapshot.legacyRows)
      )
        throw fail(
          "Restored schema or historical ledger differs; keep target isolated.",
        );
      const dataAudit = await validateData(session, restored.schema);
      const out = resolve(options.output);
      await privateDirectory(dirname(out));
      const verificationPath = out + ".data-check.sql";
      const output = await open(verificationPath, "wx", 0o600);
      try {
        await runLockedClient(
          session,
          options.mysqldump || "mysqldump",
          dumpArgs(options, true),
          { signal, output },
        );
        await output.sync();
      } finally {
        await output.close();
      }
      const { data } = await digestSQL(verificationPath);
      if (!equal(data, manifest.dump.data))
        throw fail(
          "Restored data does not equal the consistent backup INSERT stream.",
        );
      await assertLock(session);
      return writeJSON(out, "restore-check", {
        backupManifestSha256: evidence.sha256,
        backupSha256: manifest.dump.sha256,
        sourceIdentity: manifest.snapshot.identity,
        isolatedIdentity: restored.identity,
        schemaSha256: restored.schemaSha256,
        legacyRowsSha256: restored.legacyRowsSha256,
        data,
        dataAudit,
        toolHashes: await toolHashes(),
        activated: false,
        comparison:
          "isolated restored data equals this backup snapshot; not a claim about later source writes",
      });
    },
  );
}
export async function plan(options) {
  const inspected = await readJSON(options.inspect, "inspect");
  const saved = await backupEvidence(options.backup);
  const restored = await readJSON(options["restore-evidence"], "restore-check");
  const tools = await toolHashes();
  if (
    [inspected.value, saved.value, restored.value].some(
      (value) => !equal(value.toolHashes, tools),
    ) ||
    saved.value.inspectionSha256 !== inspected.sha256 ||
    restored.value.backupManifestSha256 !== saved.sha256 ||
    restored.value.backupSha256 !== saved.value.dump.sha256 ||
    restored.value.schemaSha256 !== saved.value.snapshot.schemaSha256 ||
    restored.value.legacyRowsSha256 !== saved.value.snapshot.legacyRowsSha256 ||
    !equal(restored.value.data, saved.value.dump.data) ||
    restored.value.isolatedIdentity.serverUuid ===
      saved.value.snapshot.identity.serverUuid
  )
    throw fail(
      "Evidence does not form a matching inspected, backed-up and isolated-restored chain.",
    );
  compareInspection(saved.value.snapshot, inspected.value);
  return writeJSON(options.output, "plan", {
    inspection: inspected.value,
    inspectionSha256: inspected.sha256,
    backupManifest: saved.value,
    backupManifestSha256: saved.sha256,
    restoreEvidence: restored.value,
    restoreEvidenceSha256: restored.sha256,
    toolHashes: tools,
    migrations: OFFICIAL,
    operation:
      "Register exactly ten historical migrations using staged rows and atomic RENAME; preserve legacy ledger and all business data; never execute historical DDL on source.",
    requiredApproval:
      "Specific approval of this plan SHA-256 for this server UUID and database; quiesced maintenance required.",
  });
}
function desiredRows(oldRows) {
  return OFFICIAL.map((file) => ({
    name: file.name,
    checksum: file.checksum,
    dirty: 0,
    appliedAt: oldRows.find((row) => row.checksum === file.checksum).appliedAt,
  }));
}
async function currentRows(session, table) {
  return session.json(
    `SELECT JSON_OBJECT('name',name,'checksum',checksum,'dirty',dirty,'appliedAt',DATE_FORMAT(applied_at,'%Y-%m-%dT%H:%i:%s.%fZ')) FROM ${ident(table)} ORDER BY name`,
  );
}
export async function apply(options) {
  if (!options["approve-ledger-only"] || !options["maintenance-confirmed"])
    throw fail(
      "Apply requires explicit ledger-only approval and quiesced maintenance acknowledgement.",
    );
  const saved = await readJSON(options.plan, "plan");
  if (
    !shaPattern.test(options["plan-sha256"]) ||
    saved.sha256 !== options["plan-sha256"]
  )
    throw fail("Reviewed plan SHA-256 does not match; no write attempted.");
  const reviewed = saved.value;
  if (
    !equal(reviewed.toolHashes, await toolHashes()) ||
    !equal(reviewed.migrations, OFFICIAL)
  )
    throw fail("Tool or official source identity changed after review.");
  await sourceFiles(options.migrations);
  const backup = await backupEvidence(options.backup);
  if (
    backup.sha256 !== reviewed.backupManifestSha256 ||
    !equal(backup.value, reviewed.backupManifest)
  )
    throw fail("Reviewed backup no longer matches.");
  return withSession(options, async (session) => {
    await lock(session, options);
    const id = await identity(session);
    if (!equal(id, reviewed.inspection.snapshot.identity))
      throw fail("Plan targets a different database identity.");
    const desired = desiredRows(reviewed.inspection.snapshot.legacyRows);
    const [present] = await session.query(
      `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${CURRENT}'`,
    );
    const current = await capture(session, present === "1" ? [CURRENT] : []);
    compareInspection(current, reviewed.inspection);
    if (present === "1") {
      if (!equal(await currentRows(session, CURRENT), desired))
        throw fail(
          "Existing current ledger is not the exact completed adoption; never replace or truncate it.",
        );
      await validateCurrentSchema(
        session,
        CURRENT,
        reviewed.inspection.snapshot.schema.database[0],
      );
      return {
        command: "apply",
        result: "ALREADY_APPLIED",
        planSha256: saved.sha256,
        historicalRecords: 10,
        businessWrites: 0,
      };
    }
    await validateData(session, current.schema);
    await assertLock(session);
    const stage = "artfi_adopt_" + randomUUID().replaceAll("-", "");
    // A crash before RENAME leaves ONLY a noncanonical staging table. The standard
    // migrator still refuses the nonempty unadopted DB; it can never replay 1–10.
    // No catch/drop cleanup: preserve uncertain outcomes for operator investigation.
    await session.query(
      `CREATE TABLE ${ident(stage)} (name VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, checksum CHAR(64) NOT NULL, dirty BOOLEAN NOT NULL, applied_at TIMESTAMP(6) NULL)`,
    );
    await session.query("START TRANSACTION");
    for (const row of desired)
      await session.query(
        `INSERT INTO ${ident(stage)} (name,checksum,dirty,applied_at) VALUES (${literal(row.name)},${literal(row.checksum)},FALSE,${literal(row.appliedAt.replace("T", " ").replace("Z", ""))})`,
      );
    await session.query("COMMIT");
    if (!equal(await currentRows(session, stage), desired))
      throw fail(
        "Staged ledger validation failed; canonical ledger was not created.",
      );
    await validateCurrentSchema(
      session,
      stage,
      reviewed.inspection.snapshot.schema.database[0],
    );
    compareInspection(await capture(session, [stage]), reviewed.inspection);
    await assertLock(session);
    await session.query(`RENAME TABLE ${ident(stage)} TO ${CURRENT}`);
    if (!equal(await currentRows(session, CURRENT), desired))
      throw fail(
        "Post-rename verification is inconclusive; inspect before retrying.",
      );
    return {
      command: "apply",
      result: "APPLIED",
      planSha256: saved.sha256,
      historicalRecords: 10,
      businessWrites: 0,
      next: "Use the unchanged standard migrator for pending migrations 11–14 under separate deployment authority.",
    };
  });
}
async function validateCurrentSchema(session, table, database) {
  const columns = await session.json(
    `SELECT JSON_OBJECT('name',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'characterSet',CHARACTER_SET_NAME,'collation',COLLATION_NAME,'default',COLUMN_DEFAULT,'extra',EXTRA) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${literal(table)} ORDER BY ORDINAL_POSITION`,
  );
  const expected = [
    {
      name: "name",
      type: "varchar(190)",
      nullable: "NO",
      characterSet: "ascii",
      collation: "ascii_bin",
      default: null,
      extra: "",
    },
    {
      name: "checksum",
      type: "char(64)",
      nullable: "NO",
      characterSet: database.characterSet,
      collation: database.collation,
      default: null,
      extra: "",
    },
    {
      name: "dirty",
      type: "tinyint(1)",
      nullable: "NO",
      characterSet: null,
      collation: null,
      default: null,
      extra: "",
    },
    {
      name: "applied_at",
      type: "timestamp(6)",
      nullable: "YES",
      characterSet: null,
      collation: null,
      default: null,
      extra: "",
    },
  ];
  const [indexes] = await session.query(
    `SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${literal(table)} AND INDEX_NAME='PRIMARY' AND COLUMN_NAME='name' AND NON_UNIQUE=0 AND SEQ_IN_INDEX=1 AND SUB_PART IS NULL AND IS_VISIBLE='YES'`,
  );
  const [totalIndexes] = await session.query(
    `SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${literal(table)}`,
  );
  const [constraints] = await session.query(
    `SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${literal(table)}`,
  );
  const [engine] = await session.query(
    `SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${literal(table)}`,
  );
  if (
    !equal(columns, expected) ||
    indexes !== "1" ||
    totalIndexes !== "1" ||
    constraints !== "1" ||
    engine !== "InnoDB"
  )
    throw fail(
      "New ledger schema differs from the unchanged installer contract.",
    );
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "help")
    return "ArtFi explicit legacy adoption. Keep all outputs private (0700 directory, 0600 files).\nreference --defaults-file SOURCE.cnf --database NAME --isolated-defaults-file DISPOSABLE.cnf --isolated-database artfi_adoption_reference --isolated-target --migrations DIRECTORY --output /private/reference.json\ninspect --defaults-file SOURCE.cnf --database NAME --migrations DIRECTORY --reference /private/reference.json --output /private/inspect.json\nbackup --defaults-file SOURCE.cnf --database NAME --inspect /private/inspect.json --output /private/NEW_BACKUP_DIRECTORY\nrestore-check --defaults-file DISPOSABLE.cnf --database artfi_adoption_restore --backup /private/BACKUP --trusted-backup --isolated-target --output /private/restore.json\nplan --inspect /private/inspect.json --backup /private/BACKUP --restore-evidence /private/restore.json --output /private/plan.json\napply --defaults-file SOURCE.cnf --database NAME --migrations DIRECTORY --plan /private/plan.json --plan-sha256 EXACT_APPROVED_SHA256 --backup /private/BACKUP --approve-ledger-only --maintenance-confirmed\nOptional database commands: --mysql PATH --lock-timeout 0..300 --timeout-seconds 10..86400. Backup and restore-check: --mysqldump PATH. No credentials in arguments. No automatic adoption, DDL replay, data repair, drops, deployment, activation or remote publication.\n";
  return {
    reference,
    inspect,
    backup,
    "restore-check": restoreCheck,
    plan,
    apply,
  }[command](options);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((result) =>
      process.stdout.write(
        typeof result === "string" ? result : stable(result) + "\n",
      ),
    )
    .catch((error) => {
      process.stderr.write(
        `Legacy adoption error: ${error.code ? "File operation failed; inspect private paths and permissions." : error.message}\n`,
      );
      process.exitCode = 1;
    });
