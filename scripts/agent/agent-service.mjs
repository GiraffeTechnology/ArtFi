import { createIntentAuthorizer, INTENT_TYPES } from "./bounded-intent.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { SALE_TYPES } from "./buy-receipt.mjs";
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Transport-independent service. session is supplied ONLY by authenticated
// middleware, not JSON/body/query input. No sign/broadcast endpoint is exposed.
export function createAgentService({
  mode,
  ethers: e,
  store,
  policy,
  planFor,
  observe,
  inspectRevocation,
  clock = Date.now,
  sourceObservationTimeoutMs = 3000,
}) {
  if (mode !== "TEST_ONLY_NO_REAL_VALUE") fail("SERVICE_CONFIGURATION_INVALID");
  if (
    !Number.isSafeInteger(sourceObservationTimeoutMs) ||
    sourceObservationTimeoutMs < 10 ||
    sourceObservationTimeoutMs > 30000
  )
    fail("SERVICE_CONFIGURATION_INVALID");
  const fixed = structuredClone(policy);
  const policyHashes = [
    "allowedCounterpartyPolicy",
    "allowedVenuePolicy",
    "jurisdictionPolicy",
    "settlementPolicy",
  ];
  if (
    !fixed ||
    typeof fixed !== "object" ||
    Array.isArray(fixed) ||
    (fixed.mode !== undefined && fixed.mode !== mode) ||
    typeof e?.isAddress !== "function" ||
    typeof e?.getAddress !== "function" ||
    typeof e?.verifyTypedData !== "function" ||
    typeof e?.AbiCoder?.defaultAbiCoder !== "function" ||
    typeof e?.keccak256 !== "function" ||
    typeof e?.TypedDataEncoder?.hash !== "function"
  )
    fail("SERVICE_POLICY_INVALID");
  fixed.mode = mode;
  const domain = {
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: String(fixed.chainId),
    verifyingContract: fixed.executor,
  };
  if (
    domain.chainId !== "560048" ||
    !e.isAddress(fixed.executor) ||
    /^0x0{40}$/i.test(fixed.executor) ||
    !e.isAddress(fixed.collection) ||
    /^0x0{40}$/i.test(fixed.collection) ||
    !e.isAddress(fixed.paymentToken) ||
    /^0x0{40}$/i.test(fixed.paymentToken) ||
    !e.isAddress(fixed.venue) ||
    /^0x0{40}$/i.test(fixed.venue) ||
    !Array.isArray(fixed.counterparties) ||
    fixed.counterparties.length === 0 ||
    fixed.counterparties.some(
      (value) => !e.isAddress(value) || /^0x0{40}$/i.test(value),
    ) ||
    policyHashes.some(
      (key) =>
        typeof fixed[key] !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(fixed[key]) ||
        /^0x0{64}$/.test(fixed[key]),
    )
  )
    fail("SERVICE_POLICY_INVALID");
  for (const fn of [
    store?.prepare,
    store?.get,
    store?.noteRevocation,
    planFor,
    observe,
    inspectRevocation,
    clock,
  ])
    if (typeof fn !== "function") fail("SERVICE_ADAPTER_REQUIRED");
  const prepare = store.prepare.bind(store),
    get = store.get.bind(store),
    note = store.noteRevocation.bind(store);
  function identity(session) {
    const time = clock();
    if (
      !Number.isSafeInteger(time) ||
      session?.authenticated !== true ||
      !e.isAddress(session.wallet) ||
      !Number.isSafeInteger(session.expiresAt) ||
      session.expiresAt <= time
    )
      fail("AUTHENTICATED_SESSION_REQUIRED");
    return e.getAddress(session.wallet);
  }
  function checkPlan(plan, wallet) {
    if (
      !plan ||
      plan.mode !== mode ||
      !plan.intent ||
      !plan.sale ||
      !plan.asset ||
      plan.operationId !== plan.intent.intentId ||
      !id(plan.operationId) ||
      kernelRequestDigest(plan.domain) !== kernelRequestDigest(domain) ||
      !same(plan.intent.wallet, wallet) ||
      !same(plan.intent.principal, wallet) ||
      !same(plan.sale.buyer, wallet) ||
      !same(plan.sale.recipient, wallet) ||
      !same(plan.sale.nft, fixed.collection) ||
      !same(plan.sale.paymentToken, fixed.paymentToken) ||
      !same(plan.asset.contract, plan.sale.nft) ||
      plan.asset.tokenId !== plan.sale.tokenId ||
      String(plan.asset.chainId) !== domain.chainId
    )
      fail("PLAN_BINDING_REFUSED");
    const fields = SALE_TYPES.FixedNFTSale;
    if (
      Object.keys(plan.sale).length !== fields.length ||
      fields.some((f) => !Object.hasOwn(plan.sale, f.name))
    )
      fail("SALE_SHAPE_INVALID");
    for (const field of fields) {
      const value = plan.sale[field.name];
      if (
        field.type === "uint256" &&
        (typeof value !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(value) ||
          BigInt(value) >= 2n ** 256n)
      )
        fail("SALE_SHAPE_INVALID");
      if (
        field.type === "address" &&
        (!e.isAddress(value) || same(value, e.ZeroAddress))
      )
        fail("SALE_SHAPE_INVALID");
    }
    // A signed seller quote is independently mandatory, not a planner boolean.
    if (
      !same(
        e.verifyTypedData(domain, SALE_TYPES, plan.sale, plan.sellerSignature),
        plan.sale.seller,
      )
    )
      fail("SELLER_SIGNATURE_REFUSED");
  }
  function recheck(session, wallet) {
    if (!same(identity(session), wallet)) fail("SESSION_IDENTITY_CHANGED");
  }
  function currentSale(sale) {
    const time = clock();
    if (!Number.isSafeInteger(time) || time < 0) fail("SALE_NOT_CURRENT");
    const seconds = BigInt(Math.floor(time / 1000));
    if (
      BigInt(sale.validUntil) <= BigInt(sale.validFrom) ||
      seconds < BigInt(sale.validFrom) ||
      seconds >= BigInt(sale.validUntil)
    )
      fail("SALE_NOT_CURRENT");
  }
  const immutable = (plan, signature) => ({
    operationId: plan.operationId,
    intent: structuredClone(plan.intent),
    buyerSignature: signature,
    sale: structuredClone(plan.sale),
    sellerSignature: plan.sellerSignature,
    execution: { chainId: domain.chainId, executor: fixed.executor },
  });
  function coreFromRow(row) {
    const { authorityVersion, ...core } = row.request;
    return core;
  }
  async function owned(operationId, wallet) {
    if (!id(operationId)) fail("OPERATION_ID_INVALID");
    const row = await get(operationId);
    if (
      !row ||
      row.id !== operationId ||
      !same(row.request?.intent?.wallet, wallet)
    )
      fail("OPERATION_NOT_FOUND");
    return row;
  }
  async function revocationProof(row, transactionHash) {
    if (
      typeof transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(transactionHash) ||
      /^0x0{64}$/i.test(transactionHash)
    )
      fail("REVOCATION_HASH_INVALID");
    const normalizedHash = transactionHash.toLowerCase();
    const proof = structuredClone(
      await inspectRevocation(structuredClone(row.request), normalizedHash),
    );
    const request = row.request;
    if (
      !proof ||
      !/^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash ?? "") ||
      proof.transactionHash.toLowerCase() !== normalizedHash ||
      !same(proof.wallet, request.intent.wallet) ||
      proof.nonce !== request.intent.nonce ||
      !same(proof.executor, fixed.executor) ||
      proof.chainId !== domain.chainId ||
      !["PENDING", "CONFIRMED"].includes(proof.state) ||
      (proof.state === "CONFIRMED" && proof.canonical !== true)
    )
      fail("REVOCATION_EVIDENCE_UNPROVEN");
    return { ...proof, transactionHash: normalizedHash };
  }
  return Object.freeze({
    async getHistory(session, operationId, page = {}) {
      const wallet = identity(session);
      await owned(operationId, wallet);
      if (typeof store.listEvents !== "function")
        fail("AUDIT_DEPENDENCY_UNAVAILABLE");
      const events = await store.listEvents(operationId, page);
      recheck(session, wallet);
      return {
        id: operationId,
        mode,
        events,
        nextAfter: events.at(-1)?.id ?? page.after ?? "0",
      };
    },
    async prepareIntent(session, input) {
      const wallet = identity(session),
        requested = structuredClone(input);
      const plan = structuredClone(await planFor(requested, wallet));
      checkPlan(plan, wallet);
      currentSale(plan.sale);
      if (
        !same(plan.asset.contract, requested.contract) ||
        plan.asset.tokenId !== requested.tokenId ||
        plan.intent.maxUnitPrice !== requested.maxUnitPrice ||
        plan.intent.validUntil !== requested.validUntil
      )
        fail("PLAN_INPUT_DRIFT");
      recheck(session, wallet);
      return plan; // Not authority, not executed, no server wallet signing.
    },
    async createIntent(session, input) {
      const wallet = identity(session),
        plan = structuredClone(input);
      const allowed = new Set([
        "operationId",
        "mode",
        "domain",
        "intent",
        "asset",
        "sale",
        "sellerSignature",
        "signature",
      ]);
      if (!plan || Object.keys(plan).some((k) => !allowed.has(k)))
        fail("CREATE_SCHEMA_INVALID");
      checkPlan(plan, wallet);
      if (
        !same(
          e.verifyTypedData(domain, INTENT_TYPES, plan.intent, plan.signature),
          wallet,
        )
      )
        fail("BUYER_SIGNATURE_REFUSED");
      const core = immutable(plan, plan.signature);
      const existing = await get(plan.operationId);
      if (existing) {
        if (
          !same(existing.request?.intent?.wallet, wallet) ||
          kernelRequestDigest(coreFromRow(existing)) !==
            kernelRequestDigest(core)
        )
          fail("IMMUTABLE_REQUEST_CONFLICT");
        recheck(session, wallet);
        return { id: existing.id, state: existing.state, existing: true }; // Recovery, never re-execute/re-authorize.
      }
      const observation = structuredClone(await observe(core));
      currentSale(plan.sale);
      const authorize = createIntentAuthorizer({
        ethers: e,
        policy: fixed,
        readState: () => observation,
        clock: () => Math.floor(clock() / 1000),
      });
      const decision = authorize({
        intent: plan.intent,
        signature: plan.signature,
        proposal: {
          action: "BUY",
          opensOrder: false,
          counterparty: plan.sale.seller,
          venue: fixed.venue,
          contract: plan.sale.nft,
          tokenId: plan.sale.tokenId,
          unitPrice: plan.sale.price,
          quantity: "1",
          value: plan.sale.price,
          quotedUnitPrice: plan.sale.price,
        },
      });
      recheck(session, wallet);
      const row = await prepare({
        ...core,
        authorityVersion: decision.stateVersion,
      });
      recheck(session, wallet);
      if (
        row.id !== core.operationId ||
        kernelRequestDigest(coreFromRow(row)) !== kernelRequestDigest(core)
      )
        fail("DURABLE_CREATE_RESULT_INVALID");
      return { id: row.id, state: row.state, existing: false };
    },
    async getIntent(session, operationId) {
      const wallet = identity(session);
      let row = await owned(operationId, wallet);
      if (row.revocation?.state === "PENDING") {
        // Attestor outage does not fabricate confirmation or destroy the pending record.
        try {
          const proof = await revocationProof(
            row,
            row.revocation.transactionHash,
          );
          recheck(session, wallet);
          if (proof.state === "CONFIRMED")
            row = await note(operationId, wallet, proof);
        } catch {}
      }
      let observation;
      let sourceTimer;
      const sourceAbort = new AbortController();
      try {
        observation = structuredClone(
          await Promise.race([
            Promise.resolve().then(() =>
              observe(structuredClone(row.request), sourceAbort.signal),
            ),
            new Promise((_, reject) => {
              sourceTimer = setTimeout(() => {
                sourceAbort.abort();
                reject(Error("SOURCE_OBSERVATION_TIMEOUT"));
              }, sourceObservationTimeoutMs);
            }),
          ]),
        );
      } catch {
        // Owned durable identity remains readable during source failure. This
        // fallback is never supplied to createIntent or the executor.
        observation = { available: false, current: false, observedAt: clock() };
      } finally {
        clearTimeout(sourceTimer);
        sourceAbort.abort();
      }
      if (!observation || !Number.isSafeInteger(observation.observedAt))
        observation = { available: false, current: false, observedAt: clock() };
      recheck(session, wallet);
      const reconciled =
        row.reconciliation?.canonical === true &&
        row.reconciliation?.accountingMatches === true;
      return {
        id: row.id,
        operationId: row.id,
        mode,
        domain: structuredClone(domain),
        intent: structuredClone(row.request.intent),
        executor: fixed.executor,
        asset: {
          chainId: domain.chainId,
          contract: row.request.sale.nft,
          tokenId: row.request.sale.tokenId,
        },
        fresh: observation.available === true && observation.current === true,
        observedAt: observation.observedAt,
        grounding: {
          ...(row.oracleAttestation
            ? { oracleAttestation: structuredClone(row.oracleAttestation) }
            : {}),
          state:
            observation.assetRestricted === true
              ? "RESTRICTED"
              : observation.groundingCurrent === true
                ? "CURRENT"
                : "UNVERIFIED",
          mintAuthority: structuredClone(
            row.mintAuthority ?? { status: "NOT_CHECKED" },
          ),
        },
        execution: {
          state: row.state,
          canonical: reconciled,
          ...(row.reconciliation?.binding?.transactionHash
            ? { transactionHash: row.reconciliation.binding.transactionHash }
            : {}),
        },
        reconciliation: {
          state: reconciled ? "MATCHED" : "UNKNOWN",
          accountingMatches: reconciled,
        },
        recovery: {
          state:
            row.state === "TERMINAL_REJECTED"
              ? "STOPPED"
              : row.state === "SETTLED" && reconciled
                ? "RECOVERED"
                : row.state === "SAFE_DEGRADED" ||
                    (row.state === "PREPARED" &&
                      row.mintAuthority?.status === "UNKNOWN")
                  ? "SAFE_DEGRADED"
                  : "RECONCILING",
        },
        revocation: { state: row.revocation?.state ?? "NOT_REQUESTED" },
      }; // Never expose signatures, lease tokens, driver details or credentials.
    },
    async recordRevocation(session, operationId, transactionHash) {
      const wallet = identity(session),
        row = await owned(operationId, wallet);
      const proof = await revocationProof(row, transactionHash);
      recheck(session, wallet);
      const saved = await note(operationId, wallet, proof);
      recheck(session, wallet);
      return { id: operationId, state: saved.revocation.state };
    },
  });
}
