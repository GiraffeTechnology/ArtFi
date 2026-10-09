import { compileStage1Action } from "./stage1-action-plans.mjs";
import { validateActionAuthority } from "./action-policy.mjs";
const fail = (code) => {
  throw Error(code);
};
export function createActionService({
  store,
  ethers,
  policy,
  resolveNativePlan = null,
  clock = Date.now,
}) {
  const fixed = structuredClone(policy),
    mode = fixed.mode ?? store.mode;
  function wallet(session) {
    if (
      session?.authenticated !== true ||
      !ethers.isAddress(session.wallet) ||
      session.expiresAt <= clock()
    )
      fail("AUTHENTICATED_SESSION_REQUIRED");
    return session.wallet;
  }
  async function owned(session, id) {
    const account = wallet(session),
      row = await store.get(id);
    if (
      !row ||
      row.envelope.intent.wallet.toLowerCase() !== account.toLowerCase() ||
      row.plan.chainId !== session.chainId
    )
      fail("OPERATION_NOT_FOUND");
    wallet(session);
    return row;
  }
  async function requestFor(session, input) {
    if (!input || input.wallet?.toLowerCase() !== wallet(session).toLowerCase())
      fail("ACTION_SESSION_BINDING_REFUSED");
    if (
      fixed.chainId !== undefined &&
      String(fixed.chainId) !== session.chainId
    )
      fail("ACTION_SESSION_CHAIN_REFUSED");
    let nativePlan = null;
    if (input.marketKind === "NFT") {
      if (typeof resolveNativePlan !== "function")
        fail("NATIVE_NFT_EXECUTION_ADAPTER_REQUIRED");
      nativePlan = await resolveNativePlan(
        input.terms?.nativeOperationId,
        session.wallet,
      );
      wallet(session);
    }
    return compileStage1Action(input, {
      ethers,
      chainId: String(fixed.chainId ?? "560048"),
      nativePlan,
      mode,
    });
  }
  return Object.freeze({
    async prepareAction(session, input) {
      const plan = await requestFor(session, input);
      wallet(session);
      return {
        mode,
        supportLevel:
          mode === "TEST_ONLY_NO_REAL_VALUE"
            ? "ISOLATED_APP_SIDE_CONTRACT"
            : "CONFIGURED_APP_SIDE_CONTRACT",
        plan,
      };
    },
    async createAction(session, input) {
      if (!input || Object.keys(input).sort().join(",") !== "authority,request")
        fail("ACTION_CREATE_SCHEMA_INVALID");
      const plan = await requestFor(session, input.request),
        a = validateActionAuthority(input.authority, { ethers, policy: fixed });
      if (
        a.envelope.intent.wallet.toLowerCase() !== wallet(session).toLowerCase()
      )
        fail("ACTION_SESSION_BINDING_REFUSED");
      const record = await store.prepare(a, plan);
      wallet(session);
      return { id: record.id, mode, state: record.state, policyChecked: false };
    },
    async getAction(session, id) {
      const row = await owned(session, id);
      return {
        id: row.id,
        mode,
        supportLevel:
          mode === "TEST_ONLY_NO_REAL_VALUE"
            ? "ISOLATED_APP_SIDE_CONTRACT"
            : "CONFIGURED_APP_SIDE_CONTRACT",
        state: row.state,
        action: row.plan.action,
        marketKind: row.plan.marketKind,
        wallet: row.plan.wallet,
        asset: row.plan.asset,
        chainId: row.plan.chainId,
        cursor: row.cursor,
        steps: row.legs.map((leg) => ({
          name: leg.name,
          state: leg.state,
          ...(leg.proof
            ? {
                evidence: {
                  kind: leg.proof.kind,
                  verified: leg.proof.verified,
                  ...(leg.proof.transactionHash
                    ? { transactionHash: leg.proof.transactionHash }
                    : {}),
                  ...(leg.proof.orderKey
                    ? { orderKey: leg.proof.orderKey }
                    : {}),
                },
              }
            : {}),
        })),
        limits: {
          maxExecutions: row.envelope.intent.maxExecutions,
          maxOpenOrders: row.envelope.intent.maxOpenOrders,
          maxAggregateExposure: row.envelope.intent.maxAggregateExposure,
          validUntil: row.envelope.intent.validUntil,
        },
        recoveryAttempts: row.recoveryAttempts,
        reason: row.reason ?? null,
        observedAt: clock(),
      };
    },
    async actionHistory(session, id) {
      await owned(session, id);
      const events = await store.history(id);
      wallet(session);
      return { id, mode, events };
    },
  });
}
