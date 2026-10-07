import { createDurableStore } from "./durable-store.mjs";
import { createAgentKernel } from "./agent-kernel.mjs";
import { createAgentService } from "./agent-service.mjs";
import { createRecoveryWorker } from "./recovery-worker.mjs";

// Trusted composition root only. Pool provisioning/schema application belongs
// to the existing approved DB entry, not this module. No fallback local DB.
export function createDurableRuntime({
  pool,
  storeOptions = {},
  kernelOptions,
  serviceOptions,
}) {
  const mode = "TEST_ONLY_NO_REAL_VALUE";
  const store = createDurableStore({ ...storeOptions, mode, pool });
  const tick = createAgentKernel({ ...kernelOptions, mode, store });
  const service = createAgentService({ ...serviceOptions, mode, store });
  const worker = createRecoveryWorker({ mode, store, tick });
  let running = false;
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
          await onBatch(result);
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
