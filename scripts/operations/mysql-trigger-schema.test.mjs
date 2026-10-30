import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  validateApplicationTriggers,
  triggerSchemaQuery,
} from "./mysql-recovery.mjs";

const migration = await readFile(
  new URL(
    "../../apps/api/migrations/000015_notification_inbox.up.sql",
    import.meta.url,
  ),
  "utf8",
);
const body = migration
  .slice(migration.indexOf("SET NEW.notification_revision"))
  .trim()
  .replace(/;$/, "");
const known = {
  name: "chain_event_notification_revision",
  event: "UPDATE",
  table: "chain_events",
  order: 1,
  body,
  orientation: "ROW",
  timing: "BEFORE",
  sqlMode: "STRICT_TRANS_TABLES",
  definer: "root@localhost",
  characterSet: "utf8mb4",
  connectionCollation: "utf8mb4_0900_ai_ci",
  databaseCollation: "utf8mb4_0900_ai_ci",
};
test("accepts only the complete current migration trigger and historical empty inventory", () => {
  assert.deepEqual(validateApplicationTriggers([]), []);
  assert.deepEqual(validateApplicationTriggers([known]), [known]);
});
test("refuses unknown, duplicated, retargeted or semantically modified triggers", () => {
  for (const delta of [
    { name: "other" },
    { event: "INSERT" },
    { table: "vaults" },
    { order: 2 },
    { timing: "AFTER" },
    { orientation: "STATEMENT" },
    { body: body.replace("1, 0", "100, 0") },
    { body: body + "; DELETE FROM chain_events" },
    { definer: null },
    { characterSet: "" },
  ])
    assert.throws(
      () => validateApplicationTriggers([{ ...known, ...delta }]),
      /Unsupported schema trigger/,
    );
  assert.throws(
    () => validateApplicationTriggers([known, known]),
    /Unsupported schema trigger/,
  );
});
test("execution metadata participates in the schema fingerprint without normalization loss", () => {
  const hash = (row) =>
    createHash("sha256")
      .update(JSON.stringify({ triggers: validateApplicationTriggers([row]) }))
      .digest("hex");
  for (const key of [
    "sqlMode",
    "definer",
    "characterSet",
    "connectionCollation",
    "databaseCollation",
  ])
    assert.notEqual(hash(known), hash({ ...known, [key]: "changed" }), key);
  for (const field of [
    "ACTION_ORDER",
    "ACTION_STATEMENT",
    "SQL_MODE",
    "DEFINER",
    "CHARACTER_SET_CLIENT",
    "COLLATION_CONNECTION",
    "DATABASE_COLLATION",
  ])
    assert.ok(triggerSchemaQuery.includes(field), field);
});

test("an applied notification migration cannot silently lose its required trigger", () => {
  const ledger = [{ name: "000015_notification_inbox.up.sql" }];
  assert.throws(
    () => validateApplicationTriggers([], ledger),
    /requires its revision trigger/,
  );
  assert.deepEqual(validateApplicationTriggers([known], ledger), [known]);
});
