import { kernelRequestDigest } from "./agent-kernel.mjs";
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const fail = (code) => {
  throw Error(code);
};

// No request body, signing or transport is accepted here. Enumerate committed
// operations; kernel still must claim/CAS each one before doing anything.
// A new process begins at the first durable page; it never needs old RAM IDs.
export function createRecoveryWorker({ mode, store, tick, pageSize = 32 }) {
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    typeof store?.listRecoverable !== "function" ||
    typeof tick !== "function" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    fail("RECOVERY_WORKER_CONFIG_INVALID");
  const list = store.listRecoverable.bind(store);
  let after = "",
    running = false;
  return Object.freeze({
    async runBatch(signal) {
      if (running) fail("RECOVERY_BATCH_ALREADY_RUNNING");
      if (signal?.aborted) return { state: "STOPPED", attempted: 0 };
      running = true;
      try {
        const rows = structuredClone(await list({ after, limit: pageSize }));
        if (!Array.isArray(rows) || rows.length > pageSize)
          fail("RECOVERY_PAGE_INVALID");
        let prior = after;
        // Validate the entire bounded page before dispatching a single row.
        for (const row of rows) {
          if (
            !id(row?.id) ||
            row.id <= prior ||
            row.request?.operationId !== row.id ||
            kernelRequestDigest(row.request) !== row.requestDigest ||
            ![
              "PREPARED",
              "STARTED",
              "SUBMITTED",
              "CONFIRMED",
              "UNKNOWN",
              "RECONCILING",
              "SAFE_DEGRADED",
            ].includes(row.state)
          )
            fail("RECOVERY_PAGE_INVALID");
          prior = row.id;
        }
        const outcomes = [];
        for (const row of rows) {
          if (signal?.aborted) break;
          try {
            const result = await tick(structuredClone(row.request));
            const state = result?.state;
            outcomes.push({
              id: row.id,
              state: [
                "BUSY",
                "SETTLED",
                "TERMINAL_REJECTED",
                "SAFE_DEGRADED",
                "RECONCILING",
              ].includes(state)
                ? state
                : "SAFE_DEGRADED",
            });
          } catch {
            outcomes.push({ id: row.id, state: "SAFE_DEGRADED" });
          }
          after = row.id;
        }
        if (rows.length === 0) after = ""; // Wrap; leases/new earlier IDs become eligible again.
        return {
          state: signal?.aborted ? "STOPPED" : "BATCH_COMPLETE",
          attempted: outcomes.length,
          outcomes,
        };
      } finally {
        running = false;
      }
    },
  });
}
