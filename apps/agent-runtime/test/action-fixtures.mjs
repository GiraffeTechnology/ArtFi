// Explicit isolated fixture. Keys are random ephemeral test identities, never
// application keys. Evidence is synthetic and never presented as chain results.
import * as ethers from "ethers";
import { INTENT_TYPES } from "../../../scripts/agent/bounded-intent.mjs";
import {
  compileStage1Action,
  FRACTION_SALE_TYPES,
  WHOLE_SALE_TYPES,
  ACTION_BITS,
} from "../../../scripts/agent/stage1-action-plans.mjs";
import {
  validateActionAuthority,
  createActionPolicy,
} from "../../../scripts/agent/action-policy.mjs";
export { ethers };
export async function actionFixture({
  intentPatch = {},
  kind = "FRACTION",
  action = "PARTIAL_FILL",
} = {}) {
  const user = ethers.Wallet.createRandom(),
    seller = ethers.Wallet.createRandom(),
    asset = ethers.Wallet.createRandom().address,
    payment = ethers.Wallet.createRandom().address,
    market = ethers.Wallet.createRandom().address,
    executor = ethers.Wallet.createRandom().address;
  const now = Date.now(),
    seconds = Math.floor(now / 1000);
  const assetId = { contract: asset, tokenId: kind === "WHOLE" ? "1" : "0" };
  const policy = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    chainId: "560048",
    executor,
    paymentToken: payment,
    observationProducerIds: ["ISOLATED_STAGE1_FIXTURE"],
    assets: [{ ...assetId, kind: "RWA" }],
    venues: [{ address: market, kind }],
    counterparties: [seller.address],
    allowOpenCounterparty: true,
    allowedCounterpartyPolicy: ethers.id("TEST_ONLY_COUNTERPARTY_POLICY"),
    allowedVenuePolicy: ethers.id("TEST_ONLY_VENUE_POLICY"),
    jurisdictionPolicy: ethers.id("TEST_ONLY_JURISDICTION_POLICY"),
    settlementPolicy: ethers.id("TEST_ONLY_SETTLEMENT_POLICY"),
    maxObservationAgeMs: 10000,
    maxActionsPerMinute: 100,
  };
  const intent = {
    intentId: ethers.id(`TEST_ONLY-${user.address}`),
    principal: user.address,
    wallet: user.address,
    assetScope: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256"],
        ["560048", asset, assetId.tokenId],
      ),
    ),
    actionScope: Object.values(ACTION_BITS)
      .reduce((a, b) => a | b, 0n)
      .toString(),
    maxUnitPrice: "100",
    minUnitPrice: "1",
    maxTransactionValue: "1000",
    maxAggregateExposure: "10000",
    maxExecutions: "20",
    maxOpenOrders: "3",
    validFrom: String(seconds - 60),
    validUntil: String(seconds + 3600),
    allowedCounterpartyPolicy: policy.allowedCounterpartyPolicy,
    allowedVenuePolicy: policy.allowedVenuePolicy,
    jurisdictionPolicy: policy.jurisdictionPolicy,
    slippageLimit: "0",
    settlementPolicy: policy.settlementPolicy,
    nonce: "1",
    revocationRef: ethers.id(`TEST_ONLY_REVOCATION-${user.address}`),
    ...intentPatch,
  };
  const domain = {
    name: "ArtFi Bounded Intent",
    version: "1",
    chainId: "560048",
    verifyingContract: executor,
  };
  const envelope = {
    domain,
    intent,
    signature: await user.signTypedData(domain, INTENT_TYPES, intent),
  };
  const verified = validateActionAuthority(envelope, { ethers, policy });
  let sequence = 0;
  async function order({
    owner = seller,
    salt = "1",
    unitPrice = "10",
    maxAmount = "10",
  } = {}) {
    const intent =
      kind === "WHOLE"
        ? {
            seller: owner.address,
            collection: asset,
            tokenId: "1",
            paymentToken: payment,
            price: unitPrice,
            buyer: ethers.ZeroAddress,
            salt,
            startsAt: String(seconds - 20),
            endsAt: String(seconds + 1800),
            epoch: "0",
          }
        : {
            seller: owner.address,
            assetToken: asset,
            paymentToken: payment,
            maxAmount,
            unitPrice,
            buyer: ethers.ZeroAddress,
            salt,
            startsAt: String(seconds - 20),
            endsAt: String(seconds + 1800),
            epoch: "0",
          };
    const domain = {
      name:
        kind === "WHOLE"
          ? "ArtFi Whole Artwork Market"
          : "ArtFi Fractions Market",
      version: "1",
      chainId: 560048,
      verifyingContract: market,
    };
    return {
      intent,
      signature: await owner.signTypedData(
        domain,
        kind === "WHOLE" ? WHOLE_SALE_TYPES : FRACTION_SALE_TYPES,
        intent,
      ),
    };
  }
  function compile(terms, override = {}) {
    return compileStage1Action(
      {
        operationId: `action-${user.address.slice(2, 10)}-${++sequence}`,
        action,
        marketKind: kind,
        market,
        wallet: user.address,
        asset: assetId,
        paymentToken: payment,
        terms,
        ...override,
      },
      { ethers },
    );
  }
  function observe(leg, override = {}) {
    return {
      authority: {
        wallet: user.address,
        nonce: intent.nonce,
        intentDigest: verified.digest,
        chainId: "560048",
        assetScope: intent.assetScope,
        revocationRef: intent.revocationRef,
      },
      status: "CURRENT",
      sourceId: "ISOLATED_STAGE1_FIXTURE",
      version: "TEST_ONLY_VERSION_1",
      observedAt: Date.now(),
      revoked: false,
      nonceAvailable: true,
      contractStateCurrent: true,
      jurisdictionAllowed: true,
      counterpartyAllowed: true,
      marketRulesValid: true,
      exitSafe: true,
      systemHealthy: true,
      contractPaused: false,
      assetEligible: true,
      assetRestricted: false,
      balanceSufficient: true,
      groundingCurrent: true,
      approvedSourceCurrent: true,
      quotedValue: leg.value === "0" ? "1" : leg.value,
      executions: "0",
      aggregateExposure: "0",
      openOrders: "0",
      orderRevoked: false,
      orderRemaining: "100",
      sellerEpoch: "0",
      originalOrderRetired: true,
      availableCredit: leg.expected.args.amount,
      auction: {
        state: "ACTIVE",
        listingId: leg.orderKey,
        seller: leg.counterparty,
        asset: asset,
        paymentToken: payment,
        startsAt: String(seconds - 60),
        endsAt: String(seconds + 3600),
        minimumBid: "10",
        priorBidByWallet: true,
        hasBid: false,
        expectedBuyer: leg.expected.args.buyer,
        expectedPayment: leg.expected.args.payment,
      },
      offering: {
        id: leg.orderKey,
        asset,
        paymentToken: payment,
        account: user.address,
        state: "SETTLED",
        successful: leg.action === "CLAIM",
        availableAmount: leg.expected.args.amount,
      },
      ...override,
    };
  }
  return {
    user,
    seller,
    asset,
    payment,
    market,
    executor,
    policy,
    envelope,
    verified,
    order,
    compile,
    observe,
    authorize: createActionPolicy({ ethers, policy }),
  };
}
export function syntheticEvidence(leg, operationId, index = 0) {
  const common = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    chainId: "560048",
    sourceId: "ISOLATED_STAGE1_FIXTURE",
    observedAt: Date.now(),
    callHash: leg.callHash,
  };
  if (leg.dispatch.kind === "SIGNED_ORDER_PUBLICATION")
    return {
      ...common,
      state: "ORDER_VISIBLE",
      orderHash: leg.orderKey,
      seller: leg.wallet,
      intentHash: leg.orderKey,
      orderBodyDigest: sha(leg.dispatch.args),
    };
  const transactionHash = ethers.id(
      `SYNTHETIC_TRANSACTION_${operationId}_${index}`,
    ),
    blockHash = ethers.id("SYNTHETIC_BLOCK");
  return {
    ...common,
    transaction: {
      hash: transactionHash,
      to: leg.market,
      from: leg.wallet,
      callHash: leg.callHash,
      value: leg.transactionValue ?? "0",
      status: 1,
      blockNumber: 20,
      blockHash,
    },
    canonicalBlockHash: blockHash,
    finalizedBlockNumber: 25,
    events: [
      {
        address: leg.market,
        name: leg.expected.name,
        args: {
          ...leg.expected.args,
          ...(leg.expected.name === "ListingCreated"
            ? { listingId: "77" }
            : {}),
          ...(leg.expected.name === "IntentFilled"
            ? { filledToDate: leg.quantity }
            : {}),
        },
        removed: false,
        index: 0,
        transactionHash,
        blockHash,
      },
    ],
  };
}
import { kernelRequestDigest as sha } from "../../../scripts/agent/agent-kernel.mjs";
