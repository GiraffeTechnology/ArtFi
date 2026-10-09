import { performance } from "node:perf_hooks";
import { verifyActionEvidence } from "./action-evidence.mjs";
const stable = (error) =>
  /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
    ? error.message
    : "ACTION_DEPENDENCY_UNAVAILABLE";
const terminal = new Set(["COMPLETED", "REJECTED", "FAILED_FINAL"]);
const definitiveRefusals = new Set([
  "INTENT_NOT_CURRENT",
  "ACTION_SCOPE_REFUSED",
  "ASSET_OR_VENUE_REFUSED",
  "ASSET_SCOPE_REFUSED",
  "COUNTERPARTY_REFUSED",
  "FINANCIAL_BOUND_EXCEEDED",
  "SLIPPAGE_EXCEEDED",
  "AUTHORITY_CONSUMED",
  "EXPOSURE_EXCEEDED",
  "ACTION_SIGNATURE_INVALID",
  "ACTION_POLICY_UNSUPPORTED",
]);

export function createActionKernel({
  store,
  authorize,
  observe,
  execute,
  readEvidence,
  adapterTimeoutMs = 3000,
  clock = Date.now,
  isSuspended = () => false,
}) {
  if (
    [
      store?.claim,
      store?.renew,
      store?.startLeg,
      store?.submitted,
      store?.completeLeg,
      store?.degrade,
      store?.reject,
      store?.release,
      authorize,
      observe,
      execute,
      readEvidence,
      clock,
      isSuspended,
    ].some((fn) => typeof fn !== "function") ||
    !Number.isSafeInteger(adapterTimeoutMs) ||
    adapterTimeoutMs < 10 ||
    adapterTimeoutMs > 30000 ||
    store.leaseDurationMs <
      adapterTimeoutMs + 2 * store.operationTimeoutMs + 1000
  )
    throw Error("ACTION_KERNEL_CONFIGURATION_INVALID");
  async function bounded(call) {
    const controller = new AbortController(),
      deadline = performance.now() + adapterTimeoutMs;
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => call(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("ACTION_ADAPTER_TIMEOUT"));
          }, adapterTimeoutMs);
        }),
      ]);
      if (performance.now() >= deadline) throw Error("ACTION_ADAPTER_TIMEOUT");
      return result;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return async function tick(operationId) {
    let row,
      uncertain = false,
      attempted = false;
    try {
      row = await bounded(() => store.claim(operationId));
    } catch {
      return {
        state: "SAFE_DEGRADED",
        reason: "DURABLE_STORE_UNAVAILABLE",
        executionAttempted: false,
      };
    }
    if (!row) return { state: "BUSY", executionAttempted: false };
    const envelope = structuredClone(row.envelope),
      intentDigest = row.intentDigest,
      token = row.leaseToken;
    const observationContext = (current) => ({
      ...structuredClone(current),
      authority: {
        domain: envelope.domain,
        intent: envelope.intent,
        intentDigest,
      },
    });
    const identity = {
      id: row.id,
      digest: row.plan.digest,
      authorityKey: row.authorityKey,
    };
    const check = (candidate) => {
      if (
        candidate?.id !== identity.id ||
        candidate.plan.digest !== identity.digest ||
        candidate.authorityKey !== identity.authorityKey ||
        candidate.leaseToken !== token ||
        !Number.isSafeInteger(candidate.leaseExpiresAt) ||
        candidate.leaseExpiresAt <= clock()
      )
        throw Error("ACTION_LEASE_INVALID");
    };
    async function mutate(call) {
      check(row);
      uncertain = true;
      try {
        const next = await bounded(() => call(row));
        check(next);
        if (next.version <= row.version) throw Error("ACTION_VERSION_INVALID");
        row = next;
        uncertain = false;
        return next;
      } catch (error) {
        if (error.transactionOutcome === "ROLLED_BACK") uncertain = false;
        throw error;
      }
    }
    async function renew() {
      check(row);
      uncertain = true;
      const next = await bounded(() => store.renew(row.id, row.version, token));
      check(next);
      if (
        next.version !== row.version ||
        next.leaseExpiresAt <= row.leaseExpiresAt
      )
        throw Error("ACTION_LEASE_INVALID");
      row = next;
      uncertain = false;
    }
    try {
      check(row);
      if (terminal.has(row.state)) return row;
      let leg = structuredClone(row.plan.legs[row.cursor]);
      if (!leg) throw Error("ACTION_CURSOR_INVALID");
      if (row.legs[row.cursor].state === "PLANNED") {
        await renew();
        const observation = await bounded((signal) =>
          observe(structuredClone(leg), observationContext(row), signal),
        );
        const decision = await bounded(() =>
          authorize(envelope, structuredClone(leg), observation, {
            priorLegs: structuredClone(row.legs),
            suspended: isSuspended(),
          }),
        );
        await renew();
        await mutate((current) =>
          store.startLeg(current.id, current.version, token, decision),
        );
        await renew();
        attempted = true;
        const submission = await bounded((signal) =>
          execute(
            structuredClone(leg),
            {
              operationId: row.id,
              legIndex: row.cursor,
              intentDigest: decision.intentDigest,
              envelope: structuredClone(envelope),
            },
            signal,
          ),
        );
        await mutate((current) =>
          store.submitted(current.id, current.version, token, submission),
        );
      }
      // STARTED/UNKNOWN always reads by immutable operation+leg identity. Neither
      // an expired lease, timeout, restart nor a missing local hash enables a send.
      await renew();
      leg = structuredClone(row.plan.legs[row.cursor]);
      const evidence = await bounded((signal) =>
        readEvidence(structuredClone(leg), observationContext(row), signal),
      );
      const proof = verifyActionEvidence(leg, evidence);
      if (proof.verified === true) {
        await mutate((current) =>
          store.completeLeg(current.id, current.version, token, proof),
        );
        return row;
      }
      await mutate((current) =>
        store.degrade(
          current.id,
          current.version,
          token,
          proof.reason ?? "ACTION_OUTCOME_UNKNOWN",
        ),
      );
      return {
        state: "SAFE_DEGRADED",
        reason: proof.reason ?? "ACTION_OUTCOME_UNKNOWN",
        executionAttempted: attempted,
      };
    } catch (error) {
      const reason = stable(error);
      if (!uncertain) {
        try {
          if (row.state === "PLANNED" && definitiveRefusals.has(reason))
            await mutate((current) =>
              store.reject(current.id, current.version, token, reason),
            );
          else
            await mutate((current) =>
              store.degrade(current.id, current.version, token, reason),
            );
        } catch {}
      }
      return {
        state: row.state === "REJECTED" ? "REJECTED" : "SAFE_DEGRADED",
        reason,
        executionAttempted: attempted,
        ...(uncertain ? { storeOutcome: "UNKNOWN" } : {}),
      };
    } finally {
      if (!uncertain) {
        try {
          await bounded(() => store.release(row.id, token));
        } catch {
          /* DB lease expiry retains all operation reservations. */
        }
      }
    }
  };
}

export function createActionWorker({ store, tick, pageSize = 32 }) {
  if (
    typeof store?.listPending !== "function" ||
    typeof tick !== "function" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw Error("ACTION_WORKER_CONFIGURATION_INVALID");
  let after = "",
    running = false;
  return Object.freeze({
    async runBatch(signal) {
      if (running) throw Error("ACTION_BATCH_ALREADY_RUNNING");
      running = true;
      try {
        const rows = await store.listPending({ after, limit: pageSize }),
          outcomes = [];
        for (const row of rows) {
          if (signal?.aborted) break;
          const result = await tick(row.id);
          outcomes.push({ id: row.id, state: result.state });
          after = row.id;
        }
        if (!rows.length) after = "";
        return {
          state: "BATCH_COMPLETE",
          attempted: outcomes.length,
          outcomes,
        };
      } finally {
        running = false;
      }
    },
  });
}
