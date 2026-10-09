import { validRuntimeMode, validChainId } from "./runtime-profile.mjs";
import { INTENT_TYPES, INTENT_FIELDS } from "./bounded-intent.mjs";
import { ACTION_BITS, uint } from "./stage1-action-plans.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
const fail = (code) => {
  throw Error(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (value) =>
  typeof value === "string" &&
  /^0x[0-9a-f]{64}$/.test(value) &&
  !/^0x0{64}$/.test(value);
const policyNames = [
  "allowedCounterpartyPolicy",
  "allowedVenuePolicy",
  "jurisdictionPolicy",
  "settlementPolicy",
];
export function validateActionAuthority(envelope, { ethers: e, policy }) {
  const input = structuredClone(envelope),
    p = input?.intent;
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "domain,intent,signature" ||
    !p ||
    Object.keys(p).length !== INTENT_FIELDS.length ||
    INTENT_FIELDS.some((x) => !Object.hasOwn(p, x.name))
  )
    fail("ACTION_AUTHORITY_INVALID");
  const domain = {
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: String(policy.chainId),
    verifyingContract: policy.executor,
  };
  if (
    kernelRequestDigest(input.domain) !== kernelRequestDigest(domain) ||
    !validRuntimeMode(policy.mode) ||
    !validChainId(String(policy.chainId))
  )
    fail("ACTION_AUTHORITY_DOMAIN_REFUSED");
  for (const { name, type } of INTENT_FIELDS) {
    if (type === "uint256") uint(p[name]);
    else if (type === "bytes32" && !hash(p[name]))
      fail("ACTION_AUTHORITY_INVALID");
    else if (
      type === "address" &&
      (!e.isAddress(p[name]) || same(p[name], e.ZeroAddress))
    )
      fail("ACTION_AUTHORITY_INVALID");
  }
  const all = Object.values(ACTION_BITS).reduce((sum, n) => sum | n, 0n);
  if (
    uint(p.actionScope) === 0n ||
    (uint(p.actionScope) & ~all) !== 0n ||
    uint(p.maxExecutions) === 0n ||
    uint(p.slippageLimit) > 10000n ||
    uint(p.minUnitPrice) > uint(p.maxUnitPrice) ||
    uint(p.validUntil) <= uint(p.validFrom) ||
    !same(p.wallet, p.principal)
  )
    fail("ACTION_AUTHORITY_INVALID");
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature ?? ""))
    fail("ACTION_SIGNATURE_INVALID");
  let signer;
  try {
    signer = e.verifyTypedData(domain, INTENT_TYPES, p, input.signature);
  } catch {
    fail("ACTION_SIGNATURE_INVALID");
  }
  if (!same(signer, p.wallet)) fail("ACTION_SIGNATURE_INVALID");
  for (const name of policyNames)
    if (!hash(policy[name]) || p[name] !== policy[name])
      fail("ACTION_POLICY_UNSUPPORTED");
  const scope = {
    chainId: String(policy.chainId),
    executor: policy.executor.toLowerCase(),
    wallet: p.wallet.toLowerCase(),
  };
  return Object.freeze({
    envelope: input,
    digest: e.TypedDataEncoder.hash(domain, INTENT_TYPES, p),
    walletKey: kernelRequestDigest({
      ...scope,
      settlementPolicy: p.settlementPolicy,
    }),
    authorityKey: kernelRequestDigest({ ...scope, nonce: p.nonce }),
    intentKey: kernelRequestDigest({ ...scope, intentId: p.intentId }),
  });
}
export function createActionPolicy({ ethers: e, policy, clock = Date.now }) {
  const fixed = structuredClone(policy);
  if (
    !validRuntimeMode(fixed?.mode) ||
    !validChainId(String(fixed.chainId)) ||
    !e.isAddress(fixed.executor) ||
    !e.isAddress(fixed.paymentToken) ||
    !Array.isArray(fixed.observationProducerIds) ||
    !fixed.observationProducerIds.length ||
    fixed.observationProducerIds.some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    !Array.isArray(fixed.assets) ||
    !fixed.assets.length ||
    !Array.isArray(fixed.venues) ||
    !fixed.venues.length ||
    !Array.isArray(fixed.counterparties) ||
    !Number.isSafeInteger(fixed.maxObservationAgeMs) ||
    fixed.maxObservationAgeMs < 1 ||
    fixed.maxObservationAgeMs > 60000 ||
    !Number.isSafeInteger(fixed.maxActionsPerMinute) ||
    fixed.maxActionsPerMinute < 1 ||
    fixed.maxActionsPerMinute > 1000
  )
    fail("ACTION_POLICY_CONFIGURATION_INVALID");
  return function authorize(
    envelope,
    leg,
    observation,
    { priorLegs = [], suspended = false } = {},
  ) {
    const authority = validateActionAuthority(envelope, {
        ethers: e,
        policy: fixed,
      }),
      p = authority.envelope.intent,
      o = structuredClone(observation),
      now = clock(),
      seconds = BigInt(Math.floor(now / 1000));
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      seconds < uint(p.validFrom) ||
      seconds >= uint(p.validUntil)
    )
      fail("INTENT_NOT_CURRENT");
    if (
      leg.mode !== fixed.mode ||
      leg.chainId !== String(fixed.chainId) ||
      !same(leg.wallet, p.wallet) ||
      (uint(p.actionScope) & (ACTION_BITS[leg.action] ?? 0n)) === 0n
    )
      fail("ACTION_SCOPE_REFUSED");
    const asset = fixed.assets.find(
      (x) =>
        same(x.contract, leg.asset.contract) && x.tokenId === leg.asset.tokenId,
    );
    if (
      !asset ||
      !same(leg.paymentToken, fixed.paymentToken) ||
      !["RWA", "DIGITAL"].includes(asset.kind) ||
      !fixed.venues.some(
        (x) => same(x.address, leg.market) && x.kind === leg.marketKind,
      )
    )
      fail("ASSET_OR_VENUE_REFUSED");
    const assetHash = e.keccak256(
      e.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256"],
        [fixed.chainId, leg.asset.contract, leg.asset.tokenId],
      ),
    );
    if (p.assetScope !== assetHash) fail("ASSET_SCOPE_REFUSED");
    if (
      !same(leg.counterparty, p.wallet) &&
      !fixed.counterparties.some((x) => same(x, leg.counterparty))
    )
      fail("COUNTERPARTY_REFUSED");
    if (
      leg.dispatch.kind === "SIGNED_ORDER_PUBLICATION" &&
      same(leg.dispatch.args.intent.buyer, e.ZeroAddress) &&
      fixed.allowOpenCounterparty !== true
    )
      fail("COUNTERPARTY_REFUSED");
    if (
      !o ||
      o.status !== "CURRENT" ||
      !fixed.observationProducerIds.includes(o.sourceId) ||
      typeof o.sourceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(o.sourceId) ||
      typeof o.version !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(o.version) ||
      !Number.isSafeInteger(o.observedAt) ||
      o.observedAt > now + 5000 ||
      now - o.observedAt > fixed.maxObservationAgeMs ||
      o.revoked !== false ||
      o.nonceAvailable !== true ||
      o.contractStateCurrent !== true
    )
      fail("ACTION_OBSERVATION_UNAVAILABLE");
    if (
      !o.authority ||
      !same(o.authority.wallet, p.wallet) ||
      o.authority.nonce !== p.nonce ||
      o.authority.intentDigest !== authority.digest ||
      o.authority.chainId !== String(fixed.chainId) ||
      o.authority.assetScope !== p.assetScope ||
      o.authority.revocationRef !== p.revocationRef
    )
      fail("OBSERVATION_AUTHORITY_BINDING_REFUSED");
    if (
      o.jurisdictionAllowed !== true ||
      o.counterpartyAllowed !== true ||
      o.marketRulesValid !== true
    )
      fail("ACTION_RULE_REFUSED");
    if (leg.exit) {
      if (o.exitSafe !== true) fail("EXIT_SAFETY_UNPROVEN");
    } else {
      if (suspended || o.systemHealthy !== true || o.contractPaused !== false)
        fail("NEW_ACTIVITY_SUSPENDED");
      if (
        o.assetEligible !== true ||
        o.assetRestricted !== false ||
        o.balanceSufficient !== true
      )
        fail("ASSET_NOT_ELIGIBLE");
      if (
        asset.kind === "RWA" &&
        (o.groundingCurrent !== true || o.approvedSourceCurrent !== true)
      )
        fail("APPROVED_EVIDENCE_UNAVAILABLE");
    }
    const value = uint(leg.value),
      quantity = uint(leg.quantity),
      price = uint(leg.unitPrice);
    if (value > 0n) {
      if (
        quantity === 0n ||
        price < uint(p.minUnitPrice) ||
        price > uint(p.maxUnitPrice) ||
        value < uint(p.minUnitPrice) * quantity ||
        value > uint(p.maxUnitPrice) * quantity ||
        value > uint(p.maxTransactionValue)
      )
        fail("FINANCIAL_BOUND_EXCEEDED");
      const quote = uint(o.quotedValue, true),
        slippage = uint(p.slippageLimit);
      if (value > quote && (value - quote) * 10000n > quote * slippage)
        fail("SLIPPAGE_EXCEEDED");
    }
    if (uint(o.executions) >= uint(p.maxExecutions)) fail("AUTHORITY_CONSUMED");
    if (
      (value > 0n || leg.opensOrder) &&
      (uint(o.aggregateExposure) + value > uint(p.maxAggregateExposure) ||
        uint(o.openOrders) + (leg.opensOrder ? 1n : 0n) > uint(p.maxOpenOrders))
    )
      fail("EXPOSURE_EXCEEDED");
    if (leg.marketKind === "NFT") {
      if (
        o.nativeReviewDigest !== leg.nativeReviewDigest ||
        o.nativeOperationCurrent !== true ||
        leg.nativePlanExpiresAt <= now ||
        o.nativeApprovalsCurrent !== true
      )
        fail("NATIVE_NFT_PLAN_NOT_CURRENT");
      if (
        ["list", "offer"].includes(leg.nativeAction) &&
        fixed.allowOpenCounterparty !== true
      )
        fail("COUNTERPARTY_REFUSED");
      if (
        ["accept", "buy"].includes(leg.nativeAction) &&
        (o.nativeOfferCounterpartyAllowed !== true ||
          (fixed.allowOpenCounterparty !== true &&
            !fixed.counterparties.some((x) => same(x, o.nativeCounterparty))))
      )
        fail("COUNTERPARTY_REFUSED");
    }
    if (
      leg.dependsOn &&
      !priorLegs.some(
        (x) =>
          x.name === leg.dependsOn &&
          x.state === "COMPLETED" &&
          x.proof?.verified === true,
      )
    )
      fail("PRIOR_ACTION_UNCONFIRMED");
    if (
      leg.expected.startsAt &&
      (seconds < uint(leg.expected.startsAt) ||
        seconds >= uint(leg.expected.endsAt))
    )
      fail("ORDER_NOT_CURRENT");
    if (["FILL"].includes(leg.name)) {
      if (
        o.orderRevoked !== false ||
        uint(o.orderRemaining) < quantity ||
        o.sellerEpoch !== leg.dispatch.args[0].epoch
      )
        fail("ORDER_NOT_FILLABLE");
    }
    if (["BID", "REBID"].includes(leg.action)) {
      const auction = o.auction;
      if (
        !auction ||
        auction.state !== "ACTIVE" ||
        !same(auction.seller, leg.counterparty) ||
        !same(auction.asset, leg.asset.contract) ||
        !same(auction.paymentToken, leg.paymentToken) ||
        auction.listingId !== leg.orderKey ||
        seconds < uint(auction.startsAt) ||
        seconds >= uint(auction.endsAt) ||
        value < uint(auction.minimumBid) ||
        (leg.action === "REBID" && auction.priorBidByWallet !== true)
      )
        fail("AUCTION_BID_REFUSED");
    }
    if (leg.marketKind === "AUCTION" && leg.name === "CANCEL") {
      if (
        o.auction?.state !== "ACTIVE" ||
        o.auction.listingId !== leg.orderKey ||
        !same(o.auction.asset, leg.asset.contract) ||
        !same(o.auction.paymentToken, leg.paymentToken) ||
        !same(o.auction.seller, p.wallet) ||
        o.auction.hasBid !== false
      )
        fail("AUCTION_CANCEL_REFUSED");
    }
    if (leg.marketKind === "AUCTION" && leg.name === "SETTLE") {
      if (
        o.auction?.state !== "ACTIVE" ||
        o.auction.listingId !== leg.orderKey ||
        !same(o.auction.asset, leg.asset.contract) ||
        !same(o.auction.paymentToken, leg.paymentToken) ||
        seconds < uint(o.auction.endsAt) ||
        o.auction.expectedBuyer !== leg.expected.args.buyer ||
        o.auction.expectedPayment !== leg.expected.args.payment
      )
        fail("AUCTION_SETTLEMENT_REFUSED");
    }
    if (
      leg.name === "WITHDRAW_CREDIT" &&
      o.availableCredit !== leg.expected.args.amount
    )
      fail("CREDIT_UNAVAILABLE");
    if (
      leg.marketKind === "OFFERING" &&
      (o.offering?.id !== leg.orderKey ||
        o.offering.state !== "SETTLED" ||
        !same(o.offering.asset, leg.asset.contract) ||
        !same(o.offering.paymentToken, leg.paymentToken) ||
        !same(o.offering.account, p.wallet) ||
        o.offering.successful !== (leg.action === "CLAIM") ||
        o.offering.availableAmount !== leg.expected.args.amount)
    )
      fail("OFFERING_EXIT_UNAVAILABLE");
    if (leg.name === "REPLACE" && o.originalOrderRetired !== true)
      fail("PRIOR_ACTION_UNCONFIRMED");
    return Object.freeze({
      state: "AUTHORIZED_NOT_EXECUTED",
      authorityKey: authority.authorityKey,
      intentKey: authority.intentKey,
      walletKey: authority.walletKey,
      intentDigest: authority.digest,
      value: leg.value,
      opensOrder: leg.opensOrder,
      observedAggregateExposure: o.aggregateExposure,
      observedExecutions: o.executions,
      observedOpenOrders: o.openOrders,
      stateVersion: o.version,
      maxActionsPerMinute: fixed.maxActionsPerMinute,
    });
  };
}
