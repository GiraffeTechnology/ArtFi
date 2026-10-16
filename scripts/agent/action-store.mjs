import { TEST_MODE, validRuntimeMode } from "./runtime-profile.mjs";
import { recordOptimization } from "./learning.mjs";
import { randomUUID } from "node:crypto";
import { createDurableStore } from "./durable-store.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { uint } from "./stage1-action-plans.mjs";
const fail = (code) => {
  throw Error(code);
};
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const decode = (x) =>
  typeof x === "string" ? JSON.parse(x) : structuredClone(x);
const maximum = (a, b) => (a > b ? a : b);
const initialLedger = () => ({
  executions: "0",
  reservedValue: "0",
  openOrders: "0",
  windowStartedAt: 0,
  windowCount: 0,
});
const resourceKey = (leg, key = leg.orderKey) =>
  kernelRequestDigest({
    chainId: leg.chainId,
    market: leg.market.toLowerCase(),
    marketKind: leg.marketKind,
    orderKey: key,
  });
function ledger(value) {
  const result = decode(value);
  for (const field of ["executions", "reservedValue", "openOrders"])
    uint(result[field]);
  if (
    !Number.isSafeInteger(result.windowStartedAt) ||
    !Number.isSafeInteger(result.windowCount) ||
    result.windowCount < 0
  )
    fail("ACTION_LEDGER_INVALID");
  return result;
}
function hydrate(row) {
  const plan = decode(row.plan_json),
    record = decode(row.record_json),
    { digest, ...body } = plan;
  if (
    !id(row.operation_id) ||
    plan.operationId !== row.operation_id ||
    digest !== row.plan_digest ||
    kernelRequestDigest(body) !== digest ||
    !Number.isSafeInteger(Number(row.version)) ||
    Number(row.version) < 1 ||
    !Number.isSafeInteger(Number(row.lease_expires_ms)) ||
    ![
      "PLANNED",
      "STARTED",
      "UNKNOWN",
      "RECONCILING",
      "SAFE_DEGRADED",
      "COMPLETED",
      "REJECTED",
      "FAILED_FINAL",
    ].includes(record.state) ||
    !Number.isSafeInteger(record.cursor) ||
    record.cursor < 0 ||
    record.cursor > plan.legs.length ||
    record.legs.length !== plan.legs.length
  )
    fail("ACTION_RECORD_INVALID");
  return {
    ...record,
    id: row.operation_id,
    authorityKey: row.authority_key,
    plan,
    version: Number(row.version),
    leaseToken: row.lease_token,
    leaseExpiresAt: Number(row.lease_expires_ms),
  };
}
export function createActionStore(options) {
  const mode = options.mode;
  if (!validRuntimeMode(mode)) fail("ACTION_PROFILE_INVALID");
  // Reuse only the bounded SQL transaction mechanics; no legacy BUY methods
  // or legacy mode-labelled rows are used by this store.
  const base = createDurableStore({ ...options, mode: TEST_MODE }),
    tx = base.withTransaction,
    leaseMs = base.leaseDurationMs;
  const now = async (c) => {
    const [rows] = await c.execute(
      "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
    );
    const n = Number(rows[0]?.now_ms);
    if (!Number.isSafeInteger(n)) fail("DATABASE_CLOCK_INVALID");
    return n;
  };
  async function load(c, operationId) {
    const [rows] = await c.execute(
      "SELECT * FROM agent_action_workflows WHERE operation_id = ? FOR UPDATE",
      [operationId],
    );
    return rows[0] ? hydrate(rows[0]) : null;
  }
  async function authority(c, key) {
    const [rows] = await c.execute(
      "SELECT * FROM agent_action_authorities WHERE authority_key = ? FOR UPDATE",
      [key],
    );
    if (rows.length !== 1) fail("ACTION_AUTHORITY_MISSING");
    return {
      ...rows[0],
      envelope: decode(rows[0].envelope_json),
      ledger: ledger(rows[0].ledger_json),
    };
  }
  async function wallet(c, key) {
    const [rows] = await c.execute(
      "SELECT ledger_json FROM agent_action_wallets WHERE wallet_key = ? FOR UPDATE",
      [key],
    );
    if (rows.length !== 1) fail("ACTION_WALLET_LEDGER_MISSING");
    return ledger(rows[0].ledger_json);
  }
  async function leased(c, operationId, version, token) {
    const row = await load(c, operationId),
      time = await now(c);
    if (
      !row ||
      row.version !== version ||
      row.leaseToken !== token ||
      row.leaseExpiresAt <= time
    )
      fail("DURABLE_CAS_REFUSED");
    return { row, time };
  }
  async function save(c, row, patch, time, event) {
    const {
      id: unusedId,
      authorityKey,
      plan,
      version,
      leaseToken,
      leaseExpiresAt,
      ...record
    } = row;
    const nextVersion = version + 1;
    if (!Number.isSafeInteger(nextVersion)) fail("VERSION_OVERFLOW");
    await c.execute(
      "UPDATE agent_action_workflows SET record_json = ?, version = ? WHERE operation_id = ?",
      [JSON.stringify({ ...record, ...patch }), nextVersion, row.id],
    );
    await c.execute(
      "INSERT INTO agent_action_events (operation_id, operation_version, observed_at_ms, event_json) VALUES (?, ?, ?, ?)",
      [row.id, nextVersion, time, JSON.stringify({ mode, ...event })],
    );
    return { ...row, ...patch, version: nextVersion };
  }
  return Object.freeze({
    mode,
    leaseDurationMs: base.leaseDurationMs,
    operationTimeoutMs: base.operationTimeoutMs,
    async listPlannable({ after = "", limit = 4 } = {}) {
      if (
        (after !== "" && !/^[0-9a-f]{64}$/.test(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 32
      )
        fail("ACTION_PAGE_INVALID");
      return tx(async (c) => {
        const [rows] = await c.execute(
          "SELECT a.authority_key,a.envelope_json,a.ledger_json FROM agent_action_authorities a WHERE a.authority_key>? AND NOT EXISTS (SELECT 1 FROM agent_action_workflows w WHERE w.authority_key=a.authority_key AND JSON_UNQUOTE(JSON_EXTRACT(w.record_json,'$.state')) NOT IN ('COMPLETED','REJECTED','FAILED_FINAL')) ORDER BY a.authority_key ASC LIMIT ?",
          [after, limit],
        );
        return rows
          .map((row) => ({
            authorityKey: row.authority_key,
            envelope: decode(row.envelope_json),
            ledger: ledger(row.ledger_json),
          }))
          .filter((row) => row.ledger.profileMode === mode);
      });
    },
    async prepare(verifiedAuthority, planInput) {
      const a = structuredClone(verifiedAuthority),
        plan = structuredClone(planInput),
        { digest, ...body } = plan;
      if (
        !id(plan.operationId) ||
        plan.mode !== mode ||
        kernelRequestDigest(body) !== digest ||
        !plan.legs?.length ||
        plan.legs.length > 2 ||
        !/^0x[0-9a-f]{64}$/.test(a.digest) ||
        !["authorityKey", "intentKey", "walletKey"].every((k) =>
          /^[0-9a-f]{64}$/.test(a[k]),
        )
      )
        fail("ACTION_PREPARE_INVALID");
      const scope = {
        chainId: String(a.envelope.domain.chainId),
        executor: a.envelope.domain.verifyingContract.toLowerCase(),
        wallet: a.envelope.intent.wallet.toLowerCase(),
      };
      if (
        a.authorityKey !==
          kernelRequestDigest({ ...scope, nonce: a.envelope.intent.nonce }) ||
        a.intentKey !==
          kernelRequestDigest({
            ...scope,
            intentId: a.envelope.intent.intentId,
          }) ||
        a.walletKey !==
          kernelRequestDigest({
            ...scope,
            settlementPolicy: a.envelope.intent.settlementPolicy,
          }) ||
        plan.wallet.toLowerCase() !== scope.wallet ||
        plan.chainId !== scope.chainId
      )
        fail("ACTION_PREPARE_BINDING_REFUSED");
      return tx(async (c) => {
        try {
          await c.execute(
            "INSERT INTO agent_action_authorities (authority_key,intent_key,wallet_key,intent_digest,envelope_json,ledger_json) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE authority_key = authority_key",
            [
              a.authorityKey,
              a.intentKey,
              a.walletKey,
              a.digest,
              JSON.stringify(a.envelope),
              JSON.stringify({ ...initialLedger(), profileMode: mode }),
            ],
          );
        } catch (error) {
          if (error.code === "ER_DUP_ENTRY") fail("AUTHORITY_NONCE_CONFLICT");
          throw error;
        }
        const existing = await authority(c, a.authorityKey);
        if (
          existing.intent_key !== a.intentKey ||
          existing.ledger.profileMode !== mode ||
          existing.wallet_key !== a.walletKey ||
          existing.intent_digest !== a.digest ||
          kernelRequestDigest(existing.envelope) !==
            kernelRequestDigest(a.envelope)
        )
          fail("AUTHORITY_NONCE_CONFLICT");
        await c.execute(
          "INSERT INTO agent_action_wallets (wallet_key,ledger_json) VALUES (?,?) ON DUPLICATE KEY UPDATE wallet_key = wallet_key",
          [a.walletKey, JSON.stringify(initialLedger())],
        );
        const initial = {
          state: "PLANNED",
          cursor: 0,
          legs: plan.legs.map((x) => ({ name: x.name, state: "PLANNED" })),
          recoveryAttempts: 0,
        };
        await c.execute(
          "INSERT INTO agent_action_workflows (operation_id,authority_key,plan_digest,plan_json,record_json,version) VALUES (?,?,?,?,?,1) ON DUPLICATE KEY UPDATE operation_id = operation_id",
          [
            plan.operationId,
            a.authorityKey,
            plan.digest,
            JSON.stringify(plan),
            JSON.stringify(initial),
          ],
        );
        const row = await load(c, plan.operationId);
        if (
          row.authorityKey !== a.authorityKey ||
          row.plan.digest !== plan.digest
        )
          fail("IMMUTABLE_REQUEST_CONFLICT");
        await c.execute(
          "INSERT INTO agent_action_events (operation_id,operation_version,observed_at_ms,event_json) VALUES (?,1,?,?) ON DUPLICATE KEY UPDATE event_id = event_id",
          [
            row.id,
            await now(c),
            JSON.stringify({ mode, state: "PLANNED", action: plan.action }),
          ],
        );
        return row;
      });
    },
    async get(operationId) {
      if (!id(operationId)) fail("OPERATION_ID_INVALID");
      return tx(async (c) => {
        const row = await load(c, operationId);
        if (!row) return null;
        if (row.plan.mode !== mode) fail("ACTION_PROFILE_MISMATCH");
        const a = await authority(c, row.authorityKey);
        return { ...row, envelope: a.envelope, intentDigest: a.intent_digest };
      });
    },
    async getBudgets(operationId) {
      return tx(async (c) => {
        const row = await load(c, operationId);
        if (!row) fail("OPERATION_NOT_FOUND");
        const a = await authority(c, row.authorityKey);
        return { authority: a.ledger, wallet: await wallet(c, a.wallet_key) };
      });
    },
    async claim(operationId) {
      return tx(async (c) => {
        const row = await load(c, operationId);
        if (!row) fail("OPERATION_NOT_FOUND");
        if (row.plan.mode !== mode) fail("ACTION_PROFILE_MISMATCH");
        const time = await now(c);
        if (row.leaseToken && row.leaseExpiresAt > time) return null;
        const token = randomUUID(),
          version = row.version + 1;
        await c.execute(
          "UPDATE agent_action_workflows SET lease_token=?,lease_expires_ms=?,version=? WHERE operation_id=?",
          [token, time + leaseMs, version, row.id],
        );
        const a = await authority(c, row.authorityKey);
        return {
          ...row,
          version,
          leaseToken: token,
          leaseExpiresAt: time + leaseMs,
          envelope: a.envelope,
          intentDigest: a.intent_digest,
        };
      });
    },
    async renew(operationId, version, token) {
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token);
        const expiry = Math.max(time + leaseMs, row.leaseExpiresAt + 1);
        await c.execute(
          "UPDATE agent_action_workflows SET lease_expires_ms=? WHERE operation_id=?",
          [expiry, row.id],
        );
        return { ...row, leaseExpiresAt: expiry };
      });
    },
    async startLeg(operationId, version, token, decision) {
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token),
          leg = row.plan.legs[row.cursor];
        if (
          !leg ||
          row.state !== "PLANNED" ||
          row.legs[row.cursor].state !== "PLANNED" ||
          decision.state !== "AUTHORIZED_NOT_EXECUTED" ||
          decision.authorityKey !== row.authorityKey ||
          decision.value !== leg.value ||
          decision.opensOrder !== leg.opensOrder
        )
          fail("ACTION_START_REFUSED");
        const a = await authority(c, row.authorityKey),
          p = a.envelope.intent,
          w = await wallet(c, a.wallet_key);
        if (
          a.intent_digest !== decision.intentDigest ||
          a.ledger.profileMode !== mode ||
          a.wallet_key !== decision.walletKey ||
          a.intent_key !== decision.intentKey ||
          BigInt(Math.floor(time / 1000)) >= uint(p.validUntil) ||
          BigInt(Math.floor(time / 1000)) < uint(p.validFrom)
        )
          fail("AUTHORITY_NOT_CURRENT");
        const executions =
          maximum(
            uint(a.ledger.executions),
            uint(decision.observedExecutions),
          ) + 1n;
        const reserved =
          maximum(
            uint(w.reservedValue),
            uint(decision.observedAggregateExposure),
          ) + uint(leg.value);
        const open =
          maximum(uint(w.openOrders), uint(decision.observedOpenOrders)) +
          (leg.opensOrder ? 1n : 0n);
        if (executions > uint(p.maxExecutions)) fail("AUTHORITY_CONSUMED");
        if (
          (uint(leg.value) > 0n || leg.opensOrder) &&
          (reserved > uint(p.maxAggregateExposure) ||
            open > uint(p.maxOpenOrders) ||
            uint(leg.value) > uint(p.maxTransactionValue))
        )
          fail("EXPOSURE_EXCEEDED");
        if (
          !Number.isSafeInteger(decision.maxActionsPerMinute) ||
          decision.maxActionsPerMinute < 1 ||
          decision.maxActionsPerMinute > 1000
        )
          fail("ACTION_RATE_CONFIGURATION_INVALID");
        const within = time - w.windowStartedAt < 60000;
        const count = (within ? w.windowCount : 0) + 1;
        if (count > decision.maxActionsPerMinute) fail("ACTION_RATE_LIMITED");
        if (leg.opensOrder) {
          try {
            await c.execute(
              "INSERT INTO agent_action_open_orders (resource_key,authority_key,wallet_key,operation_id) VALUES (?,?,?,?)",
              [resourceKey(leg), row.authorityKey, a.wallet_key, row.id],
            );
          } catch (error) {
            if (error.code === "ER_DUP_ENTRY")
              fail("OPEN_ORDER_ALREADY_RESERVED");
            throw error;
          }
        }
        const nextA = {
          ...a.ledger,
          executions: executions.toString(),
          reservedValue: (
            uint(a.ledger.reservedValue) + uint(leg.value)
          ).toString(),
          openOrders: (
            uint(a.ledger.openOrders) + (leg.opensOrder ? 1n : 0n)
          ).toString(),
        };
        const nextW = {
          ...w,
          reservedValue: reserved.toString(),
          openOrders: open.toString(),
          windowStartedAt: within ? w.windowStartedAt : time,
          windowCount: count,
        };
        await c.execute(
          "UPDATE agent_action_authorities SET ledger_json=? WHERE authority_key=?",
          [JSON.stringify(nextA), row.authorityKey],
        );
        await c.execute(
          "UPDATE agent_action_wallets SET ledger_json=? WHERE wallet_key=?",
          [JSON.stringify(nextW), a.wallet_key],
        );
        const legs = structuredClone(row.legs);
        legs[row.cursor] = {
          ...legs[row.cursor],
          state: "STARTED",
          startedAt: time,
          reservedValue: leg.value,
          stateVersion: decision.stateVersion,
        };
        return save(c, row, { state: "STARTED", legs }, time, {
          state: "STARTED",
          action: leg.action,
          leg: leg.name,
          reservedValue: leg.value,
        });
      });
    },
    async completeLeg(operationId, version, token, proofInput) {
      const proof = structuredClone(proofInput);
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token),
          leg = row.plan.legs[row.cursor];
        if (
          !leg ||
          !["STARTED", "UNKNOWN", "RECONCILING", "SAFE_DEGRADED"].includes(
            row.state,
          ) ||
          row.legs[row.cursor].state === "PLANNED" ||
          proof?.verified !== true ||
          proof.state !== "CONFIRMED" ||
          !/^([0-9a-f]{64})$/.test(proof.evidenceDigest ?? "")
        )
          fail("ACTION_PROOF_REFUSED");
        if (leg.opensOrder && proof.eventName === "ListingCreated") {
          const listingId = proof.eventArgs?.listingId;
          uint(listingId, true);
          await c.execute(
            "UPDATE agent_action_open_orders SET alias_key=? WHERE resource_key=?",
            [resourceKey(leg, listingId), resourceKey(leg)],
          );
        }
        if (
          leg.exit &&
          [
            "IntentRevoked",
            "SaleIntentRevoked",
            "ListingCancelled",
            "ListingSettled",
            "OrderCancelled",
          ].includes(proof.eventName)
        ) {
          const key = resourceKey(leg),
            [orders] = await c.execute(
              "SELECT * FROM agent_action_open_orders WHERE resource_key=? OR alias_key=? FOR UPDATE",
              [key, key],
            );
          if (orders.length > 1) fail("OPEN_ORDER_ALIAS_CONFLICT");
          const order = orders[0];
          if (order && !order.closed) {
            const a = await authority(c, order.authority_key),
              w = await wallet(c, order.wallet_key);
            if (uint(a.ledger.openOrders) === 0n || uint(w.openOrders) === 0n)
              fail("OPEN_ORDER_LEDGER_INVALID");
            await c.execute(
              "UPDATE agent_action_authorities SET ledger_json=? WHERE authority_key=?",
              [
                JSON.stringify({
                  ...a.ledger,
                  openOrders: (uint(a.ledger.openOrders) - 1n).toString(),
                }),
                order.authority_key,
              ],
            );
            await c.execute(
              "UPDATE agent_action_wallets SET ledger_json=? WHERE wallet_key=?",
              [
                JSON.stringify({
                  ...w,
                  openOrders: (uint(w.openOrders) - 1n).toString(),
                }),
                order.wallet_key,
              ],
            );
            await c.execute(
              "UPDATE agent_action_open_orders SET closed=TRUE WHERE resource_key=?",
              [order.resource_key],
            );
          }
        }
        const currentAuthority = await authority(c, row.authorityKey),
          currentWallet = await wallet(c, currentAuthority.wallet_key);
        const duration = Math.max(
          0,
          Math.min(86400000, time - (row.legs[row.cursor].startedAt ?? time)),
        );
        const sample = {
          action: leg.action,
          providerId: proof.sourceId ?? "UNSPECIFIED_READ_ADAPTER",
          outcome: "SUCCESS",
          durationMs: duration,
          observedAt: time,
          ...(Number.isSafeInteger(proof.gasUsed)
            ? { gasUsed: proof.gasUsed }
            : {}),
        };
        let learning;
        try {
          learning = recordOptimization(currentWallet.learning, sample);
        } catch {
          learning = recordOptimization(null, sample);
        }
        await c.execute(
          "UPDATE agent_action_wallets SET ledger_json=? WHERE wallet_key=?",
          [
            JSON.stringify({ ...currentWallet, learning }),
            currentAuthority.wallet_key,
          ],
        );
        const legs = structuredClone(row.legs);
        legs[row.cursor] = { ...legs[row.cursor], state: "COMPLETED", proof };
        const cursor = row.cursor + 1;
        return save(
          c,
          row,
          {
            state: cursor === legs.length ? "COMPLETED" : "PLANNED",
            legs,
            cursor,
            recoveryAttempts: 0,
            reason: null,
          },
          time,
          {
            state: "COMPLETED",
            action: leg.action,
            leg: leg.name,
            evidenceDigest: proof.evidenceDigest,
            ...(proof.transactionHash
              ? { transactionHash: proof.transactionHash }
              : {}),
          },
        );
      });
    },
    async submitted(operationId, version, token, input) {
      const submission = structuredClone(input);
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token),
          leg = row.plan.legs[row.cursor];
        if (
          row.state !== "STARTED" ||
          !submission ||
          Object.keys(submission).length !== 1 ||
          !Object.keys(submission).every((key) =>
            ["transactionHash", "orderHash"].includes(key),
          ) ||
          !/^0x[0-9a-fA-F]{64}$/.test(
            submission.transactionHash ?? submission.orderHash ?? "",
          ) ||
          (["SIGNED_ORDER_PUBLICATION", "NATIVE_NFT_SIGNATURE"].includes(
            leg.dispatch.kind,
          )
            ? submission.orderHash !== leg.orderKey
            : !submission.transactionHash)
        )
          fail("ACTION_SUBMISSION_INVALID");
        const legs = structuredClone(row.legs);
        legs[row.cursor] = { ...legs[row.cursor], submission };
        return save(c, row, { legs }, time, {
          state: "SUBMITTED",
          leg: leg.name,
          ...submission,
        });
      });
    },
    async degrade(operationId, version, token, reason) {
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token);
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reason))
          reason = "DEPENDENCY_UNAVAILABLE";
        const legs = structuredClone(row.legs),
          pending = legs[row.cursor]?.state === "PLANNED",
          attempts = row.recoveryAttempts + 1;
        if (!pending && legs[row.cursor]) legs[row.cursor].state = "UNKNOWN";
        return save(
          c,
          row,
          {
            state: pending ? "PLANNED" : "SAFE_DEGRADED",
            legs,
            reason,
            recoveryAttempts: attempts,
          },
          time,
          {
            state: "SAFE_DEGRADED",
            reason,
            leg: row.plan.legs[row.cursor]?.name ?? "COMPLETE",
          },
        );
      });
    },
    async reject(operationId, version, token, reason) {
      return tx(async (c) => {
        const { row, time } = await leased(c, operationId, version, token);
        if (row.state !== "PLANNED") fail("ACTION_REJECTION_REFUSED");
        return save(c, row, { state: "REJECTED", reason }, time, {
          state: "REJECTED",
          reason,
        });
      });
    },
    async release(operationId, token) {
      return tx((c) =>
        c.execute(
          "UPDATE agent_action_workflows SET lease_token=NULL,lease_expires_ms=0 WHERE operation_id=? AND lease_token=?",
          [operationId, token],
        ),
      );
    },
    async listPending({ after = "", limit = 32 } = {}) {
      if (
        (after !== "" && !id(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("ACTION_PAGE_INVALID");
      return tx(async (c) => {
        const time = await now(c),
          [rows] = await c.execute(
            "SELECT * FROM agent_action_workflows WHERE operation_id>? AND JSON_UNQUOTE(JSON_EXTRACT(record_json,'$.state')) NOT IN ('COMPLETED','REJECTED','FAILED_FINAL') AND (lease_token IS NULL OR lease_expires_ms<=?) ORDER BY operation_id ASC LIMIT ?",
            [after, time, limit],
          );
        return rows.map(hydrate).filter((row) => row.plan.mode === mode);
      });
    },
    async history(operationId) {
      if (!id(operationId)) fail("OPERATION_ID_INVALID");
      return tx(async (c) => {
        const [rows] = await c.execute(
          "SELECT event_id,observed_at_ms,event_json FROM agent_action_events WHERE operation_id=? ORDER BY event_id ASC LIMIT 100",
          [operationId],
        );
        return rows.map((row) => ({
          id: String(row.event_id),
          observedAt: Number(row.observed_at_ms),
          ...decode(row.event_json),
        }));
      });
    },
  });
}
