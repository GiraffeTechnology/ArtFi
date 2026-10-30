import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = readFileSync(
  new URL("../operations/mysql-legacy-adoption.mjs", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function schema(");
const end = source.indexOf("async function legacy(", start);
assert.ok(start >= 0 && end > start);
test("legacy adoption refuses a trigger before schema capture or ledger mutation", async () => {
  let reads = 0;
  const schema = vm.runInNewContext(source.slice(start, end) + "\nschema", {
    objectCounts: async () => ({
      unsupportedTables: 0,
      triggers: 1,
      routines: 0,
      events: 0,
    }),
    fail: (message) => new Error(message),
    schemaQueries: { keys: "must not reach" },
  });
  await assert.rejects(
    schema({
      query: async (sql) => {
        assert.match(
          sql,
          /^SELECT COUNT\(\*\) FROM information_schema\.PARTITIONS/,
        );
        reads++;
        return ["0"];
      },
      json: async () => assert.fail("unsupported schema must not be captured"),
    }),
    {
      message:
        "Unsupported schema object: only nonpartitioned InnoDB base tables, without views, triggers, routines or events, are supported.",
    },
  );
  assert.equal(reads, 1);
});
