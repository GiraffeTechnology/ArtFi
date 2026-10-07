import { createDurableStore } from "./durable-store.mjs";
import { createAgentKernel } from "./agent-kernel.mjs";
import { createOracleObservation } from "./oracle-observation.mjs";
import { createAgentService } from "./agent-service.mjs";
import { createRecoveryWorker } from "./recovery-worker.mjs";

// Trusted composition root only. Pool provisioning/schema application belongs
// to the existing approved DB entry, not this module. No fallback local DB.
export function createDurableRuntime({
  pool,
  storeOptions = {},
  kernelOptions,
  serviceOptions,
  oracleAttestation,
}) {
  const mode = "TEST_ONLY_NO_REAL_VALUE";
  const store = createDurableStore({ ...storeOptions, mode, pool });
  if (
    oracleAttestation !== undefined &&
    (typeof oracleAttestation?.verifyAttestation !== "function" ||
      Object.hasOwn(oracleAttestation, "verifyOracleAttestation") ||
      Object.hasOwn(oracleAttestation, "attestationService"))
  )
    throw Error("ORACLE_RUNTIME_API_VERIFIER_REQUIRED");
  const wrapObservation = (observe) =>
    oracleAttestation === undefined
      ? observe
      : createOracleObservation({ ...oracleAttestation, mode, observe });
  const tick = createAgentKernel({
    ...kernelOptions,
    observe: wrapObservation(kernelOptions.observe),
    mode,
    store,
  });
  const service = createAgentService({
    ...serviceOptions,
    observe: wrapObservation(serviceOptions.observe),
    mode,
    store,
  });
  const worker = createRecoveryWorker({ mode, store, tick });
  let running = false;
  // Keep the observer bound across sequential run() calls as well as ticks.
  // A hung observer must not accumulate another notification on every restart.
  let observerRunning = false;
  return Object.freeze({
    service,
    runBatch: (signal) => worker.runBatch(signal),
    async run({ signal, intervalMs = 1000, onBatch = () => {} } = {}) {
      if (
        !(signal instanceof AbortSignal) ||
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < 10 ||
        intervalMs > 60000 ||
        typeof onBatch !== "function"
      )
        throw Error("RUNTIME_CONFIGURATION_INVALID");
      if (running) throw Error("RUNTIME_ALREADY_RUNNING");
      running = true;
      const notify = (result) => {
        if (observerRunning) return;
        observerRunning = true;
        void Promise.resolve()
          .then(() => onBatch(structuredClone(result)))
          .catch(() => {})
          .finally(() => {
            observerRunning = false;
          });
      };
      try {
        while (!signal.aborted) {
          let result;
          try {
            result = await worker.runBatch(signal);
          } catch {
            result = {
              state: "SAFE_DEGRADED",
              reason: "RECOVERY_DEPENDENCY_UNAVAILABLE",
            };
          }
          // Batch observation is non-authoritative. A broken or permanently
          // hung metrics/logging sink cannot stop durable recovery. At most one
          // notification remains in flight; later snapshots may be dropped.
          notify(result);
          if (signal.aborted) break;
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, intervalMs);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } finally {
        running = false;
      }
    },
  });
}
