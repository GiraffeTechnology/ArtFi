import { createAdvisoryPlanner } from "../../../scripts/agent/advisory-planner.mjs";
import { compileStage1Action } from "../../../scripts/agent/stage1-action-plans.mjs";
import * as ethers from "ethers";
import { createActionStore } from "../../../scripts/agent/action-store.mjs";
import { createActionPolicy } from "../../../scripts/agent/action-policy.mjs";
import {
  createActionKernel,
  createActionWorker,
} from "../../../scripts/agent/action-kernel.mjs";
import { createActionService } from "../../../scripts/agent/action-service.mjs";
import { createDurableStore } from "../../../scripts/agent/durable-store.mjs";
import { createDurableRuntime } from "../../../scripts/agent/runtime.mjs";
import { createIntentAuthorizer } from "../../../scripts/agent/bounded-intent.mjs";
import { createDatabasePool, assertDatabaseSchema } from "./mysql-pool.mjs";
import { createFixedAdapter } from "./adapter.mjs";
import { unavailableCapabilities } from "./capabilities.mjs";
import { MODE, stableCode, fail } from "./config.mjs";

export function createOfflineReadService(store, clock = Date.now) {
  async function owned(session, id) {
    if (session?.authenticated !== true || session.expiresAt <= clock())
      fail("AUTHENTICATED_SESSION_REQUIRED");
    const row = await store.get(id);
    if (
      !row ||
      row.request.intent.wallet.toLowerCase() !== session.wallet.toLowerCase()
    )
      fail("OPERATION_NOT_FOUND");
    if (session.expiresAt <= clock()) fail("AUTHENTICATED_SESSION_REQUIRED");
    return row;
  }
  return Object.freeze({
    prepareIntent: async () => fail("EXECUTION_DEPENDENCY_UNAVAILABLE"),
    createIntent: async () => fail("EXECUTION_DEPENDENCY_UNAVAILABLE"),
    recordRevocation: async () => fail("REVOCATION_DEPENDENCY_UNAVAILABLE"),
    async getIntent(session, id) {
      const row = await owned(session, id),
        request = row.request;
      const matched =
        row.reconciliation?.canonical === true &&
        row.reconciliation?.accountingMatches === true;
      return {
        id,
        operationId: id,
        mode: MODE,
        domain: {
          name: "ArtFi Bounded Intent",
          version: "1",
          chainId: request.execution.chainId,
          verifyingContract: request.execution.executor,
        },
        intent: request.intent,
        executor: request.execution.executor,
        asset: {
          chainId: request.execution.chainId,
          contract: request.sale.nft,
          tokenId: request.sale.tokenId,
        },
        fresh: false,
        observedAt: clock(),
        grounding: {
          state: "UNVERIFIED",
          mintAuthority: row.mintAuthority ?? { status: "NOT_CHECKED" },
        },
        execution: {
          state: row.state,
          canonical: matched,
          ...(row.reconciliation?.binding?.transactionHash
            ? { transactionHash: row.reconciliation.binding.transactionHash }
            : {}),
        },
        reconciliation: {
          state: matched ? "MATCHED" : "UNKNOWN",
          accountingMatches: matched,
        },
        recovery: {
          state:
            row.state === "TERMINAL_REJECTED" ? "STOPPED" : "SAFE_DEGRADED",
        },
        revocation: { state: row.revocation?.state ?? "NOT_REQUESTED" },
      };
    },
    async getHistory(session, id, page) {
      await owned(session, id);
      const events = await store.listEvents(id, page);
      if (session.expiresAt <= clock()) fail("AUTHENTICATED_SESSION_REQUIRED");
      return {
        id,
        mode: MODE,
        events,
        nextAfter: events.at(-1)?.id ?? page.after ?? "0",
      };
    },
  });
}

// Runtime startup is configuration-only. Every executable adapter ships here;
// no module path, dynamic JS import, browser-provided dependency or local signer.
export function createRuntimeController({
  config,
  clock = Date.now,
  onState = () => {},
}) {
  const mode = config.mode;
  const unavailable = (reason) => unavailableCapabilities(reason, mode);
  let pool = null,
    store = null,
    runtime = null,
    service = null,
    actionWorker = null,
    planner = null;
  let status = unavailable(
    config.database
      ? "EXECUTION_DEPENDENCY_UNAVAILABLE"
      : "AGENT_DATABASE_UNCONFIGURED",
  );
  let running = false;
  const metrics = {
    batches: 0,
    recoveryAttempts: 0,
    settledObservations: 0,
    safeDegradedObservations: 0,
  };
  const notify = () => {
    try {
      onState({
        state: status.state,
        reason: status.reason ?? null,
        observedAt: clock(),
        mode,
      });
    } catch {}
  };
  async function initialize() {
    if (!config.database) fail("AGENT_DATABASE_UNCONFIGURED");
    pool ??= await createDatabasePool(config.database);
    await assertDatabaseSchema(pool);
    store ??= createDurableStore({ mode: MODE, pool });
    if (!service) {
      const reads = createActionService({
        store: createActionStore({ mode, pool }),
        ethers,
        policy: { mode },
        clock,
      });
      service = Object.freeze({
        ...createOfflineReadService(store, clock),
        getAction: reads.getAction,
        actionHistory: reads.actionHistory,
      });
    }
    status = {
      ...unavailable(),
      capabilities: {
        ...unavailable().capabilities,
        queryIntent: true,
        history: true,
        queryActions: true,
      },
    };
    const adapter = await createFixedAdapter(config.adapter);
    if (!adapter) {
      status.reason = "EXECUTION_DEPENDENCY_UNAVAILABLE";
      return;
    }
    const policy = { ...adapter.policy, mode: MODE };
    const authorize = (request, observation) =>
      createIntentAuthorizer({
        ethers,
        policy,
        readState: () => observation,
        clock: () => Math.floor(clock() / 1000),
      })({
        intent: request.intent,
        signature: request.buyerSignature,
        proposal: {
          action: "BUY",
          opensOrder: false,
          counterparty: request.sale.seller,
          venue: policy.venue,
          contract: request.sale.nft,
          tokenId: request.sale.tokenId,
          unitPrice: request.sale.price,
          quantity: "1",
          value: request.sale.price,
          quotedUnitPrice: request.sale.price,
        },
      });
    runtime = createDurableRuntime({
      pool,
      kernelOptions: {
        authorize,
        observe: adapter.observe,
        mintAuthority: adapter.mintAuthority,
        execute: adapter.execute,
        verify: adapter.verify,
        reconcile: adapter.reconcile,
      },
      serviceOptions: {
        ethers,
        policy,
        planFor: adapter.planFor,
        observe: adapter.observe,
        inspectRevocation: adapter.inspectRevocation,
        clock,
      },
    });
    service = runtime.service;
    if (adapter.actionPolicy) {
      const actionStore = createActionStore({ mode, pool });
      const actionPolicy = createActionPolicy({
        ethers,
        policy: adapter.actionPolicy,
        resolveNativePlan: adapter.resolveNativePlan,
        clock,
      });
      const actionKernel = createActionKernel({
        store: actionStore,
        authorize: actionPolicy,
        observe: adapter.actionObserve,
        execute: adapter.actionExecute,
        readEvidence: adapter.actionEvidence,
        clock,
      });
      actionWorker = createActionWorker({
        store: actionStore,
        tick: actionKernel,
      });
      if (adapter.actionPolicy.autonomousPlanning === true) {
        planner = createAdvisoryPlanner({
          store: actionStore,
          ethers,
          policy: adapter.actionPolicy,
          authorize: actionPolicy,
          observe: adapter.actionObserve,
          readCandidates: adapter.readActionCandidates,
          compile: async (request) =>
            compileStage1Action(request, {
              ethers,
              mode: adapter.actionPolicy.mode,
              chainId: String(adapter.actionPolicy.chainId),
              nativePlan:
                request.marketKind === "NFT"
                  ? await adapter.resolveNativePlan(
                      request.terms.nativeOperationId,
                      request.wallet,
                    )
                  : null,
            }),
          clock,
        });
      }

      service = Object.freeze({
        ...service,
        ...createActionService({
          store: actionStore,
          ethers,
          policy: adapter.actionPolicy,
          resolveNativePlan: adapter.resolveNativePlan,
          clock,
        }),
      });
    }
    status = {
      ...unavailable(),
      state: "TEST_ONLY_READY",
      adapterKind: adapter.kind,
      walletProtocol: "NOT_CONFIRMED",
      capabilities: {
        prepareIntent: true,
        createIntent: true,
        queryIntent: true,
        recordRevocation: true,
        history: true,
        signIntent: false,
        revokeNonce: false,
        actionWorkflows: !!actionWorker,
        queryActions: true,
        autonomousPlanning: !!planner,
      },
      actions: unavailable().actions.map((item) =>
        ["BUY", "RECONCILE", "RETRY"].includes(item.action) ||
        (actionWorker &&
          [
            "CREATE_ORDER",
            "AMEND_ORDER",
            "CANCEL_ORDER",
            "BID",
            "REBID",
            "PARTIAL_FILL",
            "SETTLE",
            "CLAIM",
            "REFUND",
          ].includes(item.action))
          ? { action: item.action, available: true, testOnly: true }
          : item,
      ),
      limitations: [
        "Isolated ArtFi integration-test adapter; current Wallet still requires owner confirmation for each operation.",
        actionWorker
          ? "Native multi-action app-side contract is isolated TEST_ONLY; NFT delegated execution remains unavailable."
          : "Only one bounded BUY is configured.",
        "No real autonomous signing or broadcasting is available. Use the existing wallet-reviewed market screens for supported owner-confirmed actions.",
      ],
    };
  }
  return Object.freeze({
    getService: () => service,
    getStatus: () => ({
      ...structuredClone(status),
      observedAt: clock(),
      metrics: { ...metrics },
    }),
    async run({ signal }) {
      if (running || !(signal instanceof AbortSignal))
        fail("AGENT_CONTROLLER_CONFIGURATION_INVALID");
      running = true;
      try {
        while (!signal.aborted) {
          try {
            if (!runtime) await initialize();
            if (runtime) {
              const batch = await runtime.runBatch(signal);
              if (actionWorker) {
                const actions = await actionWorker.runBatch(signal);
                batch.attempted += actions.attempted;
                batch.outcomes.push(...actions.outcomes);
              }
              if (planner) {
                const planning = await planner.runBatch(signal);
                if (planning.state === "SAFE_DEGRADED")
                  batch.outcomes.push({
                    id: "planner",
                    state: "SAFE_DEGRADED",
                  });
              }
              metrics.batches++;
              metrics.recoveryAttempts += batch.attempted ?? 0;
              for (const item of batch.outcomes ?? []) {
                if (item.state === "SETTLED") metrics.settledObservations++;
                if (item.state === "SAFE_DEGRADED")
                  metrics.safeDegradedObservations++;
              }
              status.state = batch.outcomes?.some(
                (x) => x.state === "SAFE_DEGRADED",
              )
                ? "SAFE_DEGRADED"
                : "TEST_ONLY_READY";
              status.reason =
                status.state === "SAFE_DEGRADED"
                  ? "RECOVERY_DEPENDENCY_UNAVAILABLE"
                  : null;
            }
          } catch (error) {
            status = {
              ...status,
              state: "SAFE_DEGRADED",
              reason: stableCode(error),
            };
          }
          notify();
          if (signal.aborted) break;
          await new Promise((resolve) => {
            let timer;
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            };
            timer = setTimeout(done, config.worker.intervalMs);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } finally {
        running = false;
      }
    },
    async close() {
      if (running) fail("AGENT_CONTROLLER_STILL_RUNNING");
      await pool?.end();
    },
  });
}
