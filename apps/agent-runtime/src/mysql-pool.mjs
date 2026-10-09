import mysql from "mysql2/promise";
import { readBoundedFile, readSecretFile, fail } from "./config.mjs";

// The pool never provisions a schema, creates users or falls back to local data.
// Remote transport always verifies its supplied CA and server identity.
export async function createDatabasePool(config) {
  if (!config) fail("AGENT_DATABASE_UNCONFIGURED");
  const password = await readSecretFile(config.passwordFile);
  const ssl =
    config.tls === null
      ? undefined
      : {
          ca: await readBoundedFile(config.tls.caFile, 1048576),
          rejectUnauthorized: true,
          verifyIdentity: true,
          minVersion: "TLSv1.2",
        };
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password,
    ssl,
    connectionLimit: 8,
    maxIdle: 4,
    idleTimeout: 30000,
    queueLimit: 16,
    waitForConnections: true,
    connectTimeout: 3000,
    enableKeepAlive: true,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    namedPlaceholders: false,
    charset: "utf8mb4",
    flags: ["-FOUND_ROWS"],
  });
}

export async function assertDatabaseSchema(pool, timeoutMs = 3000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000)
    fail("AGENT_SCHEMA_TIMEOUT_INVALID");
  let connection,
    timer,
    expired = false,
    complete = false;
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    if (expired || performance.now() >= deadline) {
      expired = true;
      throw Error("AGENT_SCHEMA_UNAVAILABLE");
    }
  };
  const work = async () => {
    const acquired = await pool.getConnection();
    if (expired) {
      acquired.destroy();
      throw Error("AGENT_SCHEMA_UNAVAILABLE");
    }
    connection = acquired;
    for (const table of [
      "agent_slice_operations",
      "agent_slice_wallet_exposure",
      "agent_slice_reservations",
      "agent_slice_events",
      "agent_action_authorities",
      "agent_action_wallets",
      "agent_action_workflows",
      "agent_action_open_orders",
      "agent_action_events",
    ]) {
      check();
      await connection.execute(`SELECT * FROM ${table} LIMIT 0`);
      check();
    }
    complete = true;
  };
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(Error("AGENT_SCHEMA_UNAVAILABLE"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    fail("AGENT_SCHEMA_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    if (connection) {
      if (complete && !expired) connection.release();
      else connection.destroy();
    }
  }
}
