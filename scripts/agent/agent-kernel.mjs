import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

// Test-only orchestration contract. Production durable store/chain adapters not supplied here.
// Store must implement exclusive atomic claim, durable CAS transition and lease recovery.
// STARTED is committed before any submission; restart reconciles and NEVER blindly resends.
export function kernelRequestDigest(request) {
  const canonical = (value) => {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string"
    )
      return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    }
    throw new Error("REQUEST_ENCODING_INVALID");
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex");
}

export function createAgentKernel({
  mode,
  store,
  authorize,
  observe,
  execute,
  verify,
  reconcile,
  mintAuthority,
  maxRecoveryAttempts = 3,
  adapterTimeoutMs = 5000,
  clock = Date.now,
}) {
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    !Number.isSafeInteger(maxRecoveryAttempts) ||
    maxRecoveryAttempts < 1 ||
    maxRecoveryAttempts > 10 ||
    !Number.isSafeInteger(adapterTimeoutMs) ||
    adapterTimeoutMs < 10 ||
    adapterTimeoutMs > 30000
  )
    throw new Error("KERNEL_CONFIGURATION_INVALID");
  for (const fn of [
    store?.claim,
    store?.renew,
    store?.transition,
    store?.release,
    authorize,
    observe,
    execute,
    verify,
    reconcile,
    mintAuthority,
    clock,
  ])
    if (typeof fn !== "function") throw new Error("KERNEL_ADAPTER_REQUIRED");
  const claim = store.claim.bind(store),
    renew = store.renew.bind(store),
    transition = store.transition.bind(store),
    release = store.release.bind(store);
  if (
    !Number.isSafeInteger(store.leaseDurationMs) ||
    !Number.isSafeInteger(store.operationTimeoutMs) ||
    store.leaseDurationMs <
      adapterTimeoutMs + 2 * store.operationTimeoutMs + 1000
  )
    throw new Error("KERNEL_LEASE_BUDGET_INVALID");
  async function bounded(stage, call) {
    const controller = new AbortController();
    const deadline = performance.now() + adapterTimeoutMs;
    const expired = () => {
      if (performance.now() >= deadline) {
        controller.abort();
        throw new Error(`ADAPTER_${stage}_TIMEOUT`);
      }
    };
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          expired();
          return call(controller.signal);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`ADAPTER_${stage}_TIMEOUT`));
          }, adapterTimeoutMs);
        }),
      ]);
      // Timers cannot preempt synchronous JS or a microtask backlog. Do not
      // accept a late result simply because the timer callback has not run.
      expired();
      return result;
    } finally {
      clearTimeout(timer);
    }
    // Abort is advisory. A timed-out send may still complete externally. Its
    // durable STARTED anchor forbids re-execution; late results are not saved.
  }
  return async function tick(request) {
    const frozen = structuredClone(request);
    const requestDigest = kernelRequestDigest(frozen);
    let record,
      storeUncertain = false;
    try {
      record = structuredClone(
        await bounded("STORE_CLAIM", (signal) =>
          claim(frozen.operationId, requestDigest, signal),
        ),
      );
    } catch {
      return Object.freeze({
        state: "SAFE_DEGRADED",
        reason: "DURABLE_STORE_UNAVAILABLE",
        storeOutcome: "UNKNOWN",
        executionAttempted: false,
      });
    }
    if (!record)
      return Object.freeze({ state: "BUSY", executionAttempted: false });
    // An operation ID never authorizes replacing an already persisted action body.
    if (
      record.id !== frozen.operationId ||
      record.requestDigest !== requestDigest ||
      !record.request ||
      kernelRequestDigest(record.request) !== requestDigest
    ) {
      try {
        await bounded("STORE_RELEASE", (signal) =>
          release(frozen.operationId, record.leaseToken, signal),
        );
      } catch {}
      return Object.freeze({
        state: "TERMINAL_REJECTED",
        reason: "IMMUTABLE_REQUEST_CONFLICT",
        executionAttempted: false,
      });
    }
    const leaseToken = record.leaseToken;
    const persisted = structuredClone(record.request);
    const checkLease = (candidate) => {
      const now = clock();
      if (
        typeof leaseToken !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(leaseToken) ||
        candidate.leaseToken !== leaseToken ||
        !Number.isSafeInteger(now) ||
        !Number.isSafeInteger(candidate.leaseExpiresAt) ||
        now >= candidate.leaseExpiresAt ||
        !Number.isSafeInteger(candidate.version) ||
        candidate.version < 1
      )
        throw new Error("LEASE_INVALID_OR_EXPIRED");
    };
    const save = async (patch) => {
      checkLease(record);
      // Any missing/late acknowledgement may already have committed. Do not
      // send another mutation or release the lease while its outcome is unknown.
      storeUncertain = true;
      const next = structuredClone(
        await bounded("STORE_TRANSITION", (signal) =>
          transition(record.id, record.version, patch, leaseToken, signal),
        ),
      );
      if (!next) throw new Error("DURABLE_CAS_REFUSED");
      if (
        next.id !== frozen.operationId ||
        next.requestDigest !== requestDigest ||
        kernelRequestDigest(next.request) !== requestDigest ||
        next.version <= record.version ||
        next.state !== patch.state
      )
        throw new Error("DURABLE_TRANSITION_INVALID");
      checkLease(next);
      record = next;
      storeUncertain = false;
      return record;
    };
    const refreshLease = async () => {
      checkLease(record);
      storeUncertain = true;
      const next = structuredClone(
        await bounded("STORE_RENEW", (signal) =>
          renew(record.id, record.version, leaseToken, signal),
        ),
      );
      if (
        !next ||
        next.id !== frozen.operationId ||
        next.requestDigest !== requestDigest ||
        kernelRequestDigest(next.request) !== requestDigest ||
        next.version !== record.version ||
        next.leaseToken !== leaseToken ||
        next.leaseExpiresAt <= record.leaseExpiresAt
      )
        throw new Error("DURABLE_RENEWAL_INVALID");
      record = next;
      checkLease(record);
      storeUncertain = false;
    };
    let attempted = false;
    try {
      checkLease(record);
      if (record.state === "SETTLED" || record.state === "TERMINAL_REJECTED")
        return record;
      if (record.state === "PREPARED") {
        // Only the trusted service's finalized, identity-bound revocation
        // receipt may terminate an unsubmitted intent. An unavailable reader,
        // a pending receipt or an eligibility exception is not such proof.
        const revoked = record.revocation;
        if (
          revoked?.state === "CONFIRMED" &&
          revoked.canonical === true &&
          /^0x[0-9a-f]{64}$/.test(revoked.transactionHash ?? "") &&
          !/^0x0{64}$/.test(revoked.transactionHash) &&
          typeof revoked.wallet === "string" &&
          typeof revoked.executor === "string" &&
          revoked.wallet.toLowerCase() ===
            persisted.intent.wallet.toLowerCase() &&
          revoked.executor.toLowerCase() ===
            persisted.execution.executor.toLowerCase() &&
          revoked.nonce === persisted.intent.nonce &&
          revoked.chainId === persisted.execution.chainId
        ) {
          return await save({
            state: "TERMINAL_REJECTED",
            reason: "INTENT_REVOKED",
          });
        }
        await refreshLease();
        const authority = await bounded("MINT_AUTHORITY", (signal) =>
          mintAuthority(structuredClone(persisted), signal),
        );
        await save({
          state: "PREPARED",
          mintAuthority: structuredClone(authority),
        });
        if (authority.status !== "EXCLUSIVE_AT_PINNED_BLOCK")
          throw Error("MINT_AUTHORITY_UNPROVEN");
        await refreshLease();
        const observation = await bounded("OBSERVE", (signal) =>
          observe(structuredClone(persisted), signal),
        );
        checkLease(record);
        if (Object.hasOwn(observation, "oracleAttestation"))
          await save({
            state: "PREPARED",
            oracleAttestation: structuredClone(observation.oracleAttestation),
          });
        await refreshLease();
        const decision = await bounded("AUTHORIZE", (signal) =>
          authorize(
            structuredClone(persisted),
            structuredClone(observation),
            signal,
          ),
        );
        if (decision.state !== "AUTHORIZED_NOT_EXECUTED")
          return await save({
            state: "TERMINAL_REJECTED",
            reason: "AUTHORITY_REFUSED",
          });
        // Adapter must reserve exposure/nonce atomically with this transition. A validator
        // result is not itself an authorization to spend without on-chain enforcement.
        await refreshLease();
        await save({
          state: "STARTED",
          intentDigest: decision.intentDigest,
          authorityVersion: decision.stateVersion,
          reservedValue: decision.value,
          observedAggregateExposure: decision.observedAggregateExposure,
          recoveryAttempts: 0,
        });
        checkLease(record);
        await refreshLease();
        attempted = true;
        const submitted = await bounded("EXECUTE", (signal) =>
          execute(structuredClone(persisted), structuredClone(record), signal),
        );
        await save({
          state: "SUBMITTED",
          submission: structuredClone(submitted),
        });
      }
      if (record.state === "SUBMITTED") {
        await refreshLease();
        const proof = await bounded("VERIFY", (signal) =>
          verify(structuredClone(record), signal),
        );
        if (proof.state === "CONFIRMED")
          await save({ state: "CONFIRMED", proof: structuredClone(proof) });
        else await save({ state: "UNKNOWN", reason: "CONFIRMATION_UNPROVEN" });
      }
      // STARTED after a crash may have a transaction without a locally recorded hash.
      // Reconciler must discover by immutable intent/operation identity, not submit again.
      await refreshLease();
      const result = await bounded("RECONCILE", (signal) =>
        reconcile(structuredClone(record), signal),
      );
      if (
        result.state === "SETTLED" &&
        result.canonical === true &&
        result.accountingMatches === true
      ) {
        return await save({
          state: "SETTLED",
          reconciliation: structuredClone(result),
        });
      }
      const attempts = (record.recoveryAttempts ?? 0) + 1;
      return await save({
        state:
          attempts >= maxRecoveryAttempts ? "SAFE_DEGRADED" : "RECONCILING",
        recoveryAttempts: attempts,
        reason: "OUTCOME_UNPROVEN",
      });
    } catch (error) {
      // Preserve pre-submission durability; never report submitted or settled from an error.
      const reason = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
        ? error.message
        : "DEPENDENCY_UNAVAILABLE";
      try {
        if (storeUncertain) throw error;
        if (
          [
            "LEASE_INVALID_OR_EXPIRED",
            "DURABLE_CAS_REFUSED",
            "DURABLE_TRANSITION_INVALID",
          ].includes(reason)
        )
          throw error;
        const attempts = (record.recoveryAttempts ?? 0) + 1;
        // Before STARTED no executor was dispatched. Preserve PREPARED so a
        // later healthy observation can reauthorize. An uncertain STARTED commit
        // cannot be reverted by this CAS: its version has advanced in storage.
        await save({
          state: record.state === "PREPARED" ? "PREPARED" : "SAFE_DEGRADED",
          reason,
          recoveryAttempts: attempts,
        });
      } catch {
        /* Durable STARTED remains the recovery anchor when storage is unavailable. */
      }
      return Object.freeze({
        state: "SAFE_DEGRADED",
        reason,
        executionAttempted: attempted,
        reconciliationRequired: true,
        ...(storeUncertain ? { storeOutcome: "UNKNOWN" } : {}),
      });
    } finally {
      // Identity-bound release may fail during outage; the durable lease must expire safely.
      if (!storeUncertain) {
        try {
          await bounded("STORE_RELEASE", (signal) =>
            release(frozen.operationId, leaseToken, signal),
          );
        } catch {
          return Object.freeze({
            state: "SAFE_DEGRADED",
            reason: "DURABLE_RELEASE_OUTCOME_UNKNOWN",
            storeOutcome: "UNKNOWN",
            executionAttempted: attempted,
            reconciliationRequired: true,
          });
        }
      }
    }
  };
}
