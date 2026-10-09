import { compileStage1Action } from "./stage1-action-plans.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
const VERSION = "8415-bounded-trading/1",
  MODE = "TEST_ONLY_NO_REAL_VALUE";
const fail = (code) => {
  throw Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const validId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export function createWalletBoundedClient({ request }) {
  if (typeof request !== "function") fail("WALLET_BOUNDED_TRANSPORT_REQUIRED");
  async function call(method, path, body, signal) {
    const response = await request({
      method,
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (
      response?.status !== 200 ||
      response.body?.protocol !== VERSION ||
      response.body.mode !== MODE ||
      !Object.hasOwn(response.body, "result")
    ) {
      const code = response?.body?.error;
      fail(
        /^[A-Z][A-Z0-9_]{0,80}$/.test(code ?? "")
          ? code
          : "WALLET_BOUNDED_UNAVAILABLE",
      );
    }
    return structuredClone(response.body.result);
  }
  return Object.freeze({
    capabilities: (signal) =>
      call("GET", "/v1/bounded/capabilities", undefined, signal),
    inspectMandate: (mandateId, signal) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(mandateId ?? ""))
        fail("WALLET_BOUNDED_MANDATE_INVALID");
      return call(
        "GET",
        `/v1/bounded/mandates/${mandateId}`,
        undefined,
        signal,
      );
    },
    enqueue: (input, signal) =>
      call("POST", "/v1/bounded/actions", input, signal),
    get: (id, signal) => {
      if (!validId(id)) fail("WALLET_BOUNDED_ID_INVALID");
      return call("GET", `/v1/bounded/actions/${id}`, undefined, signal);
    },
    cancel: (id, signal) => {
      if (!validId(id)) fail("WALLET_BOUNDED_ID_INVALID");
      return call("POST", `/v1/bounded/actions/${id}/cancel`, {}, signal);
    },
    recover: (id, transactionHash, signal) => {
      if (!validId(id) || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash ?? ""))
        fail("WALLET_BOUNDED_RECOVERY_INVALID");
      return call(
        "POST",
        `/v1/bounded/actions/${id}/receipt`,
        { transactionHash },
        signal,
      );
    },
  });
}
// The legacy EOA intent policy and owner-reviewed wallet path are unchanged.
// A separately observed on-chain mandate supplies this mode's account authority;
// it is never fabricated into an EOA signature or a legacy principal==wallet grant.
export function createArtFiBoundedAdapter({
  ethers,
  client,
  owner,
  account,
  chainId,
  mandateId,
  clock = Date.now,
}) {
  if (
    !ethers.isAddress(owner) ||
    !ethers.isAddress(account) ||
    same(owner, account) ||
    !["31337", "560048"].includes(chainId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(mandateId ?? "") ||
    !client
  )
    fail("ARTFI_BOUNDED_SYNTHETIC_BINDING_REQUIRED");
  function session(s) {
    if (
      s?.authenticated !== true ||
      !same(s.wallet, owner) ||
      s.chainId !== chainId ||
      !Number.isSafeInteger(s.expiresAt) ||
      s.expiresAt <= clock()
    )
      fail("ARTFI_BOUNDED_OWNER_SESSION_REQUIRED");
  }
  async function prepare(s, input, signal) {
    session(s);
    if (!same(input?.wallet, account)) fail("ARTFI_BOUNDED_ACCOUNT_MISMATCH");
    if (
      !["WHOLE", "FRACTION"].includes(input.marketKind) ||
      !["BUY", "PARTIAL_FILL"].includes(input.action)
    )
      fail("ARTFI_BOUNDED_ACTION_UNSUPPORTED");
    const plan = compileStage1Action(input, { ethers, chainId, mode: MODE }),
      capabilities = await client.capabilities(signal),
      mandate = await client.inspectMandate(mandateId, signal);
    if (
      capabilities.productionReady !== false ||
      capabilities.autonomousWithinGrantedMandate !== true ||
      !same(capabilities.owner, owner) ||
      !same(capabilities.account, account) ||
      capabilities.chainId !== chainId ||
      mandate.revoked ||
      !same(mandate.owner, owner) ||
      !same(mandate.account, account) ||
      mandate.chainId !== chainId
    )
      fail("ARTFI_BOUNDED_AUTHORITY_UNAVAILABLE");
    session(s);
    return { plan, mandate };
  }
  function bind(plan, row) {
    const leg = plan.legs[0],
      p = row?.payload;
    if (
      row?.id !== plan.operationId ||
      !same(row.mandateId, mandateId) ||
      row.chainId !== chainId ||
      !same(row.owner, owner) ||
      !same(row.account, account) ||
      !p ||
      !same(p.callHash, leg.callHash) ||
      !same(p.orderHash, leg.orderKey) ||
      p.payment !== leg.value ||
      p.quantity !== leg.quantity ||
      !same(p.asset, leg.asset.contract) ||
      p.tokenId !== leg.asset.tokenId ||
      kernelRequestDigest(p.request) !== kernelRequestDigest(plan.request)
    )
      fail("ARTFI_BOUNDED_RESPONSE_BINDING_REFUSED");
    return row;
  }
  return Object.freeze({
    prepare,
    async enqueue(s, input, signal) {
      const { plan } = await prepare(s, input, signal);
      const row = await client.enqueue({ mandateId, request: input }, signal);
      session(s);
      return bind(plan, row);
    },
    async get(s, id, signal) {
      session(s);
      const row = await client.get(id, signal);
      session(s);
      if (
        row.id !== id ||
        !same(row.owner, owner) ||
        !same(row.account, account) ||
        !same(row.mandateId, mandateId)
      )
        fail("ARTFI_BOUNDED_OPERATION_NOT_FOUND");
      return row;
    },
    async cancel(s, id, signal) {
      session(s);
      const existing = await client.get(id, signal);
      session(s);
      if (
        existing.id !== id ||
        !same(existing.owner, owner) ||
        !same(existing.account, account) ||
        !same(existing.mandateId, mandateId)
      )
        fail("ARTFI_BOUNDED_OPERATION_NOT_FOUND");
      const row = await client.cancel(id, signal);
      session(s);
      if (
        row.id !== id ||
        !same(row.owner, owner) ||
        !same(row.account, account) ||
        !same(row.mandateId, mandateId)
      )
        fail("ARTFI_BOUNDED_RESPONSE_BINDING_REFUSED");
      return row;
    },
    async recover(s, id, transactionHash, signal) {
      session(s);
      const existing = await client.get(id, signal);
      session(s);
      if (
        existing.id !== id ||
        !same(existing.owner, owner) ||
        !same(existing.account, account) ||
        !same(existing.mandateId, mandateId)
      )
        fail("ARTFI_BOUNDED_OPERATION_NOT_FOUND");
      const row = await client.recover(id, transactionHash, signal);
      session(s);
      if (
        row.id !== id ||
        (row.state !== "UNKNOWN" &&
          (!same(row.owner, owner) ||
            !same(row.account, account) ||
            !same(row.mandateId, mandateId)))
      )
        fail("ARTFI_BOUNDED_RESPONSE_BINDING_REFUSED");
      return row;
    },
    // Advice can only reorder pre-existing typed candidates. It cannot change a
    // mandate, amount, action, asset, signer, or the Wallet/contract validators.
    async queueCandidates(
      s,
      candidates,
      { advise = null, limit = 4, signal } = {},
    ) {
      session(s);
      if (
        !Array.isArray(candidates) ||
        candidates.length > 64 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 16
      )
        fail("ARTFI_BOUNDED_CANDIDATES_INVALID");
      const choices = new Map();
      for (const candidate of candidates) {
        if (
          !validId(candidate?.operationId) ||
          choices.has(candidate.operationId)
        )
          fail("ARTFI_BOUNDED_CANDIDATES_INVALID");
        choices.set(candidate.operationId, structuredClone(candidate));
      }
      let order = [...choices.keys()].sort();
      if (typeof advise === "function")
        try {
          const advice = await advise(
            order.map((id) => ({ id, action: choices.get(id).action })),
          );
          if (Array.isArray(advice)) {
            const ranking = [
              ...new Set(
                advice.filter(
                  (id) => typeof id === "string" && choices.has(id),
                ),
              ),
            ];
            order = [
              ...ranking,
              ...order.filter((id) => !ranking.includes(id)),
            ];
          }
        } catch {
          /* A model outage does not create authority or block deterministic work. */
        }
      const outcomes = [];
      for (const id of order.slice(0, limit))
        try {
          outcomes.push({
            id,
            queued: true,
            record: await this.enqueue(s, choices.get(id), signal),
          });
        } catch (error) {
          outcomes.push({
            id,
            queued: false,
            reason: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "")
              ? error.message
              : "ARTFI_BOUNDED_QUEUE_UNAVAILABLE",
          });
        }
      return outcomes;
    },
  });
}
