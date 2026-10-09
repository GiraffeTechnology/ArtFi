// Isolated crash-injection child. No chain adapter exists in this process.
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createDatabasePool } from "../src/mysql-pool.mjs";
import { createDurableStore } from "../../../scripts/agent/durable-store.mjs";
const config = JSON.parse(
  await readFile(process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG, "utf8"),
);
if (
  config.database !== "artfi_stage2_isolated_test" ||
  config.host !== "127.0.0.1"
)
  throw Error("ISOLATED_TEST_DATABASE_REQUIRED");
const pool = await createDatabasePool(config);
const store = createDurableStore({
  mode: "TEST_ONLY_NO_REAL_VALUE",
  pool,
  leaseMs: 1800,
  operationTimeoutMs: 200,
  cleanupTimeoutMs: 50,
});
const row = await store.get(process.argv[2]);
const claim = await store.claim(row.id, row.requestDigest);
await store.transition(
  row.id,
  claim.version,
  {
    state: "STARTED",
    authorityVersion: "test-observation-2",
    intentDigest: "0x" + "d".repeat(64),
    reservedValue: "10",
    observedAggregateExposure: "0",
  },
  claim.leaseToken,
);
console.log("TEST_STARTED_DURABLE");
await setTimeout(60000);
await pool.end();
