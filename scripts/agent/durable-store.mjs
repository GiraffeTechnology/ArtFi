import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { kernelRequestDigest } from "./agent-kernel.mjs";

const fail = (code) => {
  throw new Error(code);
};
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const uint = (value) =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  BigInt(value) < 2n ** 256n;
const address = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  !/^0x0{40}$/.test(value);
const digest = (value) =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const states = new Set([
  "PREPARED",
  "STARTED",
  "SUBMITTED",
  "CONFIRMED",
  "UNKNOWN",
  "RECONCILING",
  "SAFE_DEGRADED",
  "SETTLED",
  "TERMINAL_REJECTED",
]);
const transitions = {
  PREPARED: ["PREPARED", "STARTED", "TERMINAL_REJECTED", "SAFE_DEGRADED"],
  STARTED: ["SUBMITTED", "RECONCILING", "SAFE_DEGRADED", "SETTLED"],
  SUBMITTED: ["CONFIRMED", "UNKNOWN", "SAFE_DEGRADED"],
  CONFIRMED: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  UNKNOWN: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  RECONCILING: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  SAFE_DEGRADED: ["SETTLED", "RECONCILING", "SAFE_DEGRADED"],
  SETTLED: [],
  TERMINAL_REJECTED: [],
};

export function reservationIdentity(request) {
  const { intent: a, execution: x, authorityVersion } = request ?? {};
  if (
    !id(request?.operationId) ||
    !a ||
    !x ||
    !id(authorityVersion) ||
    !uint(x.chainId) ||
    x.chainId !== "560048" ||
    !address(x.executor) ||
    !address(a.wallet) ||
    !uint(a.nonce) ||
    !digest(a.intentId) ||
    !uint(a.maxAggregateExposure) ||
    !uint(request?.sale?.price) ||
    a.actionScope !== "1" ||
    a.maxExecutions !== "1" ||
    a.maxOpenOrders !== "0"
  )
    fail("RESERVATION_DESCRIPTOR_INVALID");
  const scope = {
    chainId: x.chainId,
    executor: x.executor.toLowerCase(),
    wallet: a.wallet.toLowerCase(),
  };
  return {
    authorityKey: kernelRequestDigest({ ...scope, nonce: a.nonce }),
    intentKey: kernelRequestDigest({ ...scope, intentId: a.intentId }),
    exposureKey: kernelRequestDigest(scope),
  };
}
const decode = (value) =>
  typeof value === "string" ? JSON.parse(value) : structuredClone(value);
function validateMintAuthority(value, request) {
  if (
    !value ||
    !["UNKNOWN", "EXCLUSIVE_AT_PINNED_BLOCK"].includes(value.status)
  )
    fail("MINT_AUTHORITY_RECORD_INVALID");
  if (
    value.status === "EXCLUSIVE_AT_PINNED_BLOCK" &&
    (value.productionApproved !== false ||
      value.chainId !== request.execution.chainId ||
      value.nft?.toLowerCase() !== request.sale?.nft?.toLowerCase() ||
      !address(value.consumer) ||
      !address(value.policy) ||
      !Number.isSafeInteger(value.blockNumber) ||
      value.blockNumber < 0 ||
      !digest(value.blockHash) ||
      value.requestedBlockNumber !== value.blockNumber ||
      value.requestedBlockHash !== value.blockHash)
  )
    fail("MINT_AUTHORITY_RECORD_INVALID");
  // Storage preserves evidence; it cannot independently establish chain truth.
  kernelRequestDigest(value);
}
function validateRevocation(proof, request) {
  const keys = [
    "transactionHash",
    "wallet",
    "nonce",
    "executor",
    "chainId",
    "state",
    "canonical",
  ];
  if (
    !proof ||
    Object.keys(proof).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(proof, k)) ||
    !digest(proof.transactionHash) ||
    !address(proof.wallet) ||
    !address(proof.executor) ||
    proof.wallet.toLowerCase() !== request.intent.wallet.toLowerCase() ||
    proof.nonce !== request.intent.nonce ||
    proof.executor.toLowerCase() !== request.execution.executor.toLowerCase() ||
    proof.chainId !== request.execution.chainId ||
    !["PENDING", "CONFIRMED"].includes(proof.state) ||
    typeof proof.canonical !== "boolean" ||
    (proof.state === "CONFIRMED" && proof.canonical !== true)
  )
    fail("REVOCATION_RECORD_INVALID");
}
export function hydrateOperation(row) {
  const request = decode(row.request_json),
    record = decode(row.record_json);
  reservationIdentity(request);
  if (
    !id(row.operation_id) ||
    request.operationId !== row.operation_id ||
    kernelRequestDigest(request) !== row.request_digest ||
    !states.has(record.state)
  )
    fail("DURABLE_ROW_INVALID");
  const version = Number(row.version),
    expiry = Number(row.lease_expires_ms);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(expiry) ||
    expiry < 0 ||
    (row.lease_token !== null && !id(row.lease_token))
  )
    fail("DURABLE_ROW_INVALID");
  if (Object.hasOwn(record, "revocation"))
    validateRevocation(record.revocation, request);
  if (Object.hasOwn(record, "mintAuthority"))
    validateMintAuthority(record.mintAuthority, request);
  // Immutable identity always comes from verified columns, never record_json.
  return {
    ...record,
    id: row.operation_id,
    request,
    requestDigest: row.request_digest,
    version,
    leaseToken: row.lease_token,
    leaseExpiresAt: expiry,
  };
}

// No connection/configuration discovery or credential handling here. The trusted
// composition root supplies a mysql2-compatible pool for the approved dedicated
// <CLOUD_PROVIDER_A> TEST_ONLY database role only.
// Unit contracts are not evidence of an actual DB transaction/lease campaign.
export function createDurableStore({
  mode,
  pool,
  leaseMs = 30000,
  operationTimeoutMs = 4000,
  cleanupTimeoutMs = 250,
}) {
  if (
    mode !== "TEST_ONLY_NO_REAL_VALUE" ||
    typeof pool?.getConnection !== "function" ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 120000 ||
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 10 ||
    operationTimeoutMs > 30000 ||
    !Number.isSafeInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs < 10 ||
    cleanupTimeoutMs > 1000
  )
    fail("DURABLE_CONFIGURATION_INVALID");
  const safeError = (error, fallback) =>
    new Error(
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message ?? "")
        ? error.message
        : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? "")
          ? error.code
          : fallback,
    );
  // Each operation has one total work budget, not a fresh budget per SQL query.
  // Cleanup is separately bounded. This bounds waiting, not synchronous JS or
  // server cancellation; timed-out protocol state is destroyed, never reused.
  async function bounded(stage, call, deadline, onLate) {
    let timer,
      expired = false,
      lateHandled = false;
    const timeout = () => new Error(`DURABLE_${stage}_TIMEOUT`);
    const late = (value) => {
      if (!onLate || lateHandled) return;
      lateHandled = true;
      Promise.resolve()
        .then(() => onLate(value))
        .catch(() => {});
    };
    let pending;
    try {
      if (performance.now() >= deadline) throw timeout();
      pending = Promise.resolve().then(call);
      pending.then(
        (value) => {
          if (expired) late(value);
        },
        () => {},
      );
      const value = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(timeout());
            },
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
      if (performance.now() >= deadline) {
        expired = true;
        late(value);
        throw timeout();
      }
      return value;
    } catch (error) {
      expired = true;
      if (performance.now() >= deadline) throw timeout();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function discard(c, error) {
    error.connectionDiscarded = false;
    if (typeof c?.destroy !== "function") {
      error.cleanupCode = "CONNECTION_DISCARD_UNAVAILABLE";
      return;
    }
    try {
      await bounded(
        "DESTROY",
        () => c.destroy(),
        performance.now() + cleanupTimeoutMs,
      );
      error.connectionDiscarded = true;
    } catch {
      error.cleanupCode = "CONNECTION_DISCARD_FAILED";
    }
    // Never fall back to release on unknown protocol/transaction state.
  }
  let acquisitionRetryAfter = 0;
  async function transaction(body) {
    const deadline = performance.now() + operationTimeoutMs;
    let c,
      acquirePending = false;
    let outcome = "ACQUIRE_UNKNOWN",
      result,
      primary = null;
    if (performance.now() < acquisitionRetryAfter) {
      const error = new Error("DURABLE_ACQUISITION_BACKOFF");
      error.transactionOutcome = outcome;
      throw error;
    }
    try {
      c = await bounded(
        "ACQUIRE",
        () => {
          acquirePending = true;
          const pending = Promise.resolve().then(() => pool.getConnection());
          const settled = () => {
            acquirePending = false;
          };
          pending.then(settled, settled);
          return pending;
        },
        deadline,
        (lateConnection) =>
          discard(lateConnection, new Error("LATE_ACQUISITION_DISCARDED")),
      );
    } catch (error) {
      if (acquirePending) {
        acquisitionRetryAfter = Math.max(
          acquisitionRetryAfter,
          performance.now() + cleanupTimeoutMs,
        );
      }
      primary = safeError(error, "DURABLE_ACQUIRE_FAILED");
      primary.transactionOutcome = outcome;
      // A future connection is discarded by onLate; no claim that it is gone now.
      primary.connectionDiscarded = false;
      throw primary;
    }
    try {
      outcome = "BEGIN_UNKNOWN";
      await bounded("BEGIN", () => c.beginTransaction(), deadline);
      outcome = "ACTIVE";
      const guarded = {
        execute: async (...args) => {
          try {
            return await bounded("QUERY", () => c.execute(...args), deadline);
          } catch (error) {
            if (error.message === "DURABLE_QUERY_TIMEOUT")
              outcome = "QUERY_UNKNOWN";
            throw error;
          }
        },
      };
      result = await body(guarded);
      outcome = "COMMIT_UNKNOWN";
      await bounded("COMMIT", () => c.commit(), deadline);
      outcome = "COMMITTED";
    } catch (error) {
      primary = safeError(error, "DURABLE_OPERATION_FAILED");
      if (outcome === "ACTIVE") {
        outcome = "ROLLBACK_UNKNOWN";
        try {
          await bounded(
            "ROLLBACK",
            () => c.rollback(),
            performance.now() + cleanupTimeoutMs,
          );
          outcome = "ROLLED_BACK";
        } catch {
          primary.cleanupCode = "ROLLBACK_FAILED";
        }
      }
      // QUERY/BEGIN/COMMIT timeout may leave a command in flight: do not enqueue
      // rollback or infer no commit. A late completion cannot resume the body.
    }
    if (!["COMMITTED", "ROLLED_BACK"].includes(outcome)) {
      primary ??= new Error("DURABLE_TRANSACTION_OUTCOME_UNKNOWN");
      primary.transactionOutcome = outcome;
      await discard(c, primary);
      throw primary;
    }
    try {
      await bounded(
        "RELEASE",
        () => c.release(),
        performance.now() + cleanupTimeoutMs,
      );
    } catch {
      primary ??= new Error(
        outcome === "COMMITTED"
          ? "DURABLE_COMMITTED_RELEASE_FAILED"
          : "DURABLE_RELEASE_FAILED",
      );
      primary.cleanupCode = "CONNECTION_RELEASE_FAILED";
      await discard(c, primary);
    }
    if (primary) {
      primary.transactionOutcome = outcome;
      throw primary;
    }
    return result;
  }
  async function now(c) {
    const [rows] = await c.execute(
      "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
    );
    const time = Number(rows[0]?.now_ms);
    if (!Number.isSafeInteger(time) || time < 0) fail("DATABASE_CLOCK_INVALID");
    return time;
  }
  async function load(c, operationId) {
    const [rows] = await c.execute(
      "SELECT * FROM agent_slice_operations WHERE operation_id = ? FOR UPDATE",
      [operationId],
    );
    return rows.length === 0 ? null : hydrateOperation(rows[0]);
  }
  return Object.freeze({
    leaseDurationMs: leaseMs,
    operationTimeoutMs,
    async listRecoverable({ after = "", limit = 32 } = {}) {
      if (
        (after !== "" && !id(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("RECOVERY_PAGE_INVALID");
      return transaction(async (c) => {
        const time = await now(c);
        const [rows] = await c.execute(
          "SELECT * FROM agent_slice_operations WHERE operation_id > ? AND JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.state')) NOT IN ('SETTLED', 'TERMINAL_REJECTED') AND (lease_token IS NULL OR lease_expires_ms <= ?) ORDER BY operation_id ASC LIMIT ?",
          [after, time, limit],
        );
        if (!Array.isArray(rows) || rows.length > limit)
          fail("RECOVERY_PAGE_INVALID");
        let previous = after;
        return rows.map((raw) => {
          const row = hydrateOperation(raw);
          if (
            row.id <= previous ||
            ["SETTLED", "TERMINAL_REJECTED"].includes(row.state) ||
            (row.leaseToken && row.leaseExpiresAt > time)
          )
            fail("RECOVERY_PAGE_INVALID");
          previous = row.id;
          return row;
        });
      });
    },
    async get(operationId) {
      if (!id(operationId)) fail("OPERATION_ID_INVALID");
      return transaction(async (c) => {
        const [rows] = await c.execute(
          "SELECT * FROM agent_slice_operations WHERE operation_id = ?",
          [operationId],
        );
        return rows.length === 0 ? null : hydrateOperation(rows[0]);
      });
    },
    async noteRevocation(operationId, wallet, proofInput) {
      const proof = structuredClone(proofInput);
      if (
        !id(operationId) ||
        !address(wallet) ||
        !proof ||
        !digest(proof.transactionHash) ||
        !["PENDING", "CONFIRMED"].includes(proof.state) ||
        typeof proof.canonical !== "boolean"
      )
        fail("REVOCATION_RECORD_INVALID");
      kernelRequestDigest(proof);
      return transaction(async (c) => {
        const row = await load(c, operationId);
        if (
          !row ||
          row.request.intent.wallet.toLowerCase() !== wallet.toLowerCase()
        )
          fail("OPERATION_NOT_FOUND");
        validateRevocation(proof, row.request);
        if (row.revocation) {
          if (row.revocation.transactionHash !== proof.transactionHash)
            fail("REVOCATION_RECORD_CONFLICT");
          if (
            row.revocation.state === "CONFIRMED" ||
            kernelRequestDigest(row.revocation) === kernelRequestDigest(proof)
          )
            return row;
        }
        const {
          id: unusedId,
          request,
          requestDigest,
          version,
          leaseToken,
          leaseExpiresAt,
          ...body
        } = row;
        if (!Number.isSafeInteger(version + 1)) fail("VERSION_OVERFLOW");
        await c.execute(
          "UPDATE agent_slice_operations SET record_json = ?, version = ? WHERE operation_id = ?",
          [
            JSON.stringify({ ...body, revocation: proof }),
            version + 1,
            operationId,
          ],
        );
        return { ...row, revocation: proof, version: version + 1 };
      });
    },
    async prepare(input) {
      const request = structuredClone(input);
      reservationIdentity(request);
      const requestDigest = kernelRequestDigest(request);
      return transaction(async (c) => {
        // INSERT's unique PK serializes concurrent first preparation. Do not
        // use INSERT IGNORE: truncated/invalid data must remain a hard error.
        await c.execute(
          "INSERT INTO agent_slice_operations (operation_id, request_digest, request_json, record_json, version) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE operation_id = operation_id",
          [
            request.operationId,
            requestDigest,
            JSON.stringify(request),
            JSON.stringify({ state: "PREPARED", recoveryAttempts: 0 }),
          ],
        );
        const row = await load(c, request.operationId);
        if (row.requestDigest !== requestDigest)
          fail("IMMUTABLE_REQUEST_CONFLICT");
        return row;
      });
    },
    async claim(operationId, requestDigest) {
      if (!id(operationId) || !/^[0-9a-f]{64}$/.test(requestDigest))
        fail("CLAIM_INVALID");
      return transaction(async (c) => {
        const row = await load(c, operationId);
        if (!row) fail("OPERATION_NOT_PREPARED");
        if (row.requestDigest !== requestDigest)
          fail("IMMUTABLE_REQUEST_CONFLICT");
        const time = await now(c);
        if (row.leaseToken && row.leaseExpiresAt > time) return null;
        const token = randomUUID(),
          version = row.version + 1;
        if (!Number.isSafeInteger(version)) fail("VERSION_OVERFLOW");
        await c.execute(
          "UPDATE agent_slice_operations SET lease_token = ?, lease_expires_ms = ?, version = ? WHERE operation_id = ?",
          [token, time + leaseMs, version, operationId],
        );
        return {
          ...row,
          version,
          leaseToken: token,
          leaseExpiresAt: time + leaseMs,
        };
      });
    },
    async renew(operationId, expectedVersion, token) {
      if (
        !id(operationId) ||
        !id(token) ||
        !Number.isSafeInteger(expectedVersion)
      )
        fail("LEASE_RENEWAL_INVALID");
      return transaction(async (c) => {
        const row = await load(c, operationId),
          time = await now(c);
        if (
          !row ||
          row.version !== expectedVersion ||
          row.leaseToken !== token ||
          row.leaseExpiresAt <= time
        )
          fail("DURABLE_CAS_REFUSED");
        const expiry = Math.max(time + leaseMs, row.leaseExpiresAt + 1);
        if (!Number.isSafeInteger(expiry)) fail("LEASE_EXPIRY_OVERFLOW");
        const [result] = await c.execute(
          "UPDATE agent_slice_operations SET lease_expires_ms = ? WHERE operation_id = ? AND version = ? AND lease_token = ? AND lease_expires_ms > ?",
          [expiry, operationId, expectedVersion, token, time],
        );
        if (result?.affectedRows !== 1) fail("DURABLE_CAS_REFUSED");
        return { ...row, leaseExpiresAt: expiry };
      });
    },
    async transition(operationId, expectedVersion, patchInput, token) {
      const patch = structuredClone(patchInput);
      const allowed = new Set([
        "state",
        "intentDigest",
        "authorityVersion",
        "recoveryAttempts",
        "submission",
        "proof",
        "reconciliation",
        "reason",
        "mintAuthority",
        "reservedValue",
        "observedAggregateExposure",
      ]);
      if (
        !id(operationId) ||
        !id(token) ||
        !Number.isSafeInteger(expectedVersion) ||
        !patch ||
        Object.keys(patch).some((k) => !allowed.has(k)) ||
        !states.has(patch.state)
      )
        fail("TRANSITION_INVALID");
      kernelRequestDigest(patch); // Reject BigInt/undefined/exotic mutable values.
      return transaction(async (c) => {
        const row = await load(c, operationId),
          time = await now(c);
        if (
          !row ||
          row.version !== expectedVersion ||
          row.leaseToken !== token ||
          row.leaseExpiresAt <= time
        )
          fail("DURABLE_CAS_REFUSED");
        if (!transitions[row.state].includes(patch.state))
          fail("STATE_TRANSITION_REFUSED");
        if (Object.hasOwn(patch, "mintAuthority")) {
          if (row.state !== "PREPARED" || patch.state !== "PREPARED")
            fail("MINT_AUTHORITY_PATCH_STATE_REFUSED");
          validateMintAuthority(patch.mintAuthority, row.request);
        }
        if (patch.state === "PREPARED") {
          if (
            Object.keys(patch).some(
              (k) =>
                ![
                  "state",
                  "reason",
                  "recoveryAttempts",
                  "mintAuthority",
                ].includes(k),
            )
          )
            fail("PREPARED_RETRY_PATCH_REFUSED");
          const [reservations] = await c.execute(
            "SELECT intent_digest FROM agent_slice_reservations WHERE operation_id = ?",
            [operationId],
          );
          if (reservations.length !== 0) fail("PREPARED_HAS_RESERVATION");
        }
        if (patch.state === "SETTLED") {
          const [reservations] = await c.execute(
            "SELECT intent_digest FROM agent_slice_reservations WHERE operation_id = ?",
            [operationId],
          );
          if (
            reservations.length !== 1 ||
            reservations[0].intent_digest !== row.intentDigest ||
            patch.reconciliation?.canonical !== true ||
            patch.reconciliation?.accountingMatches !== true
          )
            fail("SETTLEMENT_EVIDENCE_REFUSED");
        }
        if (patch.state === "STARTED") {
          if (
            !id(patch.authorityVersion) ||
            !digest(patch.intentDigest) ||
            !uint(patch.reservedValue) ||
            !uint(patch.observedAggregateExposure) ||
            BigInt(patch.reservedValue) === 0n ||
            patch.reservedValue !== row.request.sale.price
          )
            fail("AUTHORITY_VERSION_REFUSED");
          // Creation's observation version is historical, not an immutable
          // authorization term. The trusted kernel reauthorizes before STARTED
          // and records its current version here. Lease/CAS and unique authority
          // reservation still bind the unchanged signed request; on-chain
          // execution must independently enforce nonce and financial limits.
          const keys = reservationIdentity(row.request);
          try {
            await c.execute(
              "INSERT INTO agent_slice_wallet_exposure (exposure_key, reserved_value) VALUES (?, 0) ON DUPLICATE KEY UPDATE exposure_key = exposure_key",
              [keys.exposureKey],
            );
            const [exposures] = await c.execute(
              "SELECT reserved_value FROM agent_slice_wallet_exposure WHERE exposure_key = ? FOR UPDATE",
              [keys.exposureKey],
            );
            if (
              exposures.length !== 1 ||
              !uint(String(exposures[0].reserved_value))
            )
              fail("EXPOSURE_RECORD_INVALID");
            const storedExposure = BigInt(exposures[0].reserved_value),
              observedExposure = BigInt(patch.observedAggregateExposure),
              exposureBaseline =
                storedExposure > observedExposure
                  ? storedExposure
                  : observedExposure,
              nextExposure = exposureBaseline + BigInt(patch.reservedValue);
            if (nextExposure > BigInt(row.request.intent.maxAggregateExposure))
              fail("EXPOSURE_EXCEEDED");
            await c.execute(
              "UPDATE agent_slice_wallet_exposure SET reserved_value = ? WHERE exposure_key = ?",
              [nextExposure.toString(), keys.exposureKey],
            );
            await c.execute(
              "INSERT INTO agent_slice_reservations (authority_key, intent_key, exposure_key, operation_id, intent_digest, reserved_value) VALUES (?, ?, ?, ?, ?, ?)",
              [
                keys.authorityKey,
                keys.intentKey,
                keys.exposureKey,
                operationId,
                patch.intentDigest,
                patch.reservedValue,
              ],
            );
          } catch (error) {
            if (error.code === "ER_DUP_ENTRY")
              fail("AUTHORITY_ALREADY_RESERVED");
            throw error;
          }
        }
        const {
          id: unusedId,
          request,
          requestDigest,
          version,
          leaseToken,
          leaseExpiresAt,
          ...body
        } = row;
        const nextVersion = version + 1;
        if (!Number.isSafeInteger(nextVersion)) fail("VERSION_OVERFLOW");
        await c.execute(
          "UPDATE agent_slice_operations SET record_json = ?, version = ? WHERE operation_id = ?",
          [JSON.stringify({ ...body, ...patch }), nextVersion, operationId],
        );
        return { ...row, ...patch, version: nextVersion };
      });
    },
    async release(operationId, token) {
      if (!id(operationId) || !id(token)) fail("RELEASE_IDENTITY_INVALID");
      return transaction(async (c) => {
        await c.execute(
          "UPDATE agent_slice_operations SET lease_token = NULL, lease_expires_ms = 0 WHERE operation_id = ? AND lease_token = ?",
          [operationId, token],
        );
      });
    },
  });
}
