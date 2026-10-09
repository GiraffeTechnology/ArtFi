import test from "node:test";
import assert from "node:assert/strict";
import * as ethers from "ethers";
import { compileStage1Action } from "../../../scripts/agent/stage1-action-plans.mjs";
import {
  createActionPolicy,
  validateActionAuthority,
} from "../../../scripts/agent/action-policy.mjs";
import { INTENT_TYPES } from "../../../scripts/agent/bounded-intent.mjs";
import { verifyActionEvidence } from "../../../scripts/agent/action-evidence.mjs";
import { kernelRequestDigest } from "../../../scripts/agent/agent-kernel.mjs";

// Existing Stage 1 NftPlan/NftRequest shapes. These are offline Ethereum/Base
// shaped records, not RPC queries, chain selection or real transactions.
export async function nftFixture(nativeAction = "accept", chainId = "1") {
  const user = ethers.Wallet.createRandom(),
    market = ethers.Wallet.createRandom().address,
    asset = ethers.Wallet.createRandom().address,
    payment = ethers.Wallet.createRandom().address,
    executor = ethers.Wallet.createRandom().address;
  const action = {
      accept: "ACCEPT_OFFER",
      buy: "BUY",
      cancel: "CANCEL_ORDER",
      list: "CREATE_ORDER",
      offer: "CREATE_ORDER",
    }[nativeAction],
    creating = ["list", "offer"].includes(nativeAction);
  const orderHash = ethers.id("OFFLINE_SYNTHETIC_ORDER"),
    operationId = `offline-nft-${user.address.slice(2, 10)}`;
  const request = {
    operationId,
    action,
    marketKind: "NFT",
    market,
    wallet: user.address,
    asset: { contract: asset, tokenId: "1" },
    paymentToken: payment,
    terms: { nativeOperationId: "test-native-record" },
  };
  const nativePlan = {
    id: "test-native-plan",
    operationId: "test-native-record",
    sessionId: "test-session",
    chainId: Number(chainId),
    request: {
      action: nativeAction,
      collection: "test-only-collection",
      tokenId: "1",
      account: user.address,
      quantity: "1",
      priceWei: "100",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      ...(!creating ? { orderHash } : {}),
    },
    scope: {
      slug: "test-only-collection",
      chain: chainId === "1" ? "ethereum" : "base",
      contract: asset,
      standard: "erc721",
      label: "TEST_ONLY",
      charity: false,
    },
    expiresAt: Date.now() + 120000,
    kind: creating ? "signature" : "transaction",
    summary: "OFFLINE TEST_ONLY plan",
    fees: [],
    orderHash,
    orderTotalWei: "100",
    orderExpiresAt: Math.floor(Date.now() / 1000) + 300,
    paymentToken:
      nativeAction === "buy" || nativeAction === "list" ? "ETH" : "WETH",
    ...(creating
      ? {
          typedData: {
            domain: {
              name: "Seaport",
              version: "1.6",
              chainId: Number(chainId),
              verifyingContract: market,
            },
            types: { OrderComponents: [] },
            primaryType: "OrderComponents",
            message: { offerer: user.address },
          },
        }
      : {
          transaction: {
            to: market,
            data: "0x12345678",
            value: nativeAction === "buy" ? "100" : "0",
          },
        }),
  };
  const policy = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    chainId,
    executor,
    paymentToken: payment,
    observationProducerIds: ["OFFLINE_NATIVE_PLAN_FIXTURE"],
    assets: [{ contract: asset, tokenId: "1", kind: "DIGITAL" }],
    venues: [{ address: market, kind: "NFT" }],
    counterparties: [],
    allowOpenCounterparty: true,
    maxObservationAgeMs: 10000,
    maxActionsPerMinute: 30,
    allowedCounterpartyPolicy: ethers.id("TEST_COUNTERPARTY"),
    allowedVenuePolicy: ethers.id("TEST_VENUE"),
    jurisdictionPolicy: ethers.id("TEST_JURISDICTION"),
    settlementPolicy: ethers.id("TEST_SETTLEMENT"),
  };
  const intent = {
    intentId: ethers.id(`TEST_INTENT_${user.address}`),
    principal: user.address,
    wallet: user.address,
    assetScope: ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256"],
        [chainId, asset, "1"],
      ),
    ),
    actionScope: "2047",
    maxUnitPrice: "100",
    minUnitPrice: "1",
    maxTransactionValue: "100",
    maxAggregateExposure: "1000",
    maxExecutions: "3",
    maxOpenOrders: "2",
    validFrom: String(Math.floor(Date.now() / 1000) - 1),
    validUntil: String(Math.floor(Date.now() / 1000) + 300),
    allowedCounterpartyPolicy: policy.allowedCounterpartyPolicy,
    allowedVenuePolicy: policy.allowedVenuePolicy,
    jurisdictionPolicy: policy.jurisdictionPolicy,
    slippageLimit: "0",
    settlementPolicy: policy.settlementPolicy,
    nonce: "1",
    revocationRef: ethers.id("TEST_REVOCATION"),
  };
  const domain = {
      name: "ArtFi Bounded Intent",
      version: "1",
      chainId,
      verifyingContract: executor,
    },
    envelope = {
      domain,
      intent,
      signature: await user.signTypedData(domain, INTENT_TYPES, intent),
    };
  const plan = compileStage1Action(request, { ethers, chainId, nativePlan });
  const observation = {
    authority: {
      wallet: user.address,
      nonce: intent.nonce,
      intentDigest: ethers.TypedDataEncoder.hash(domain, INTENT_TYPES, intent),
      chainId,
      assetScope: intent.assetScope,
      revocationRef: intent.revocationRef,
    },
    status: "CURRENT",
    sourceId: "OFFLINE_NATIVE_PLAN_FIXTURE",
    version: "v1",
    observedAt: Date.now(),
    revoked: false,
    nonceAvailable: true,
    contractStateCurrent: true,
    jurisdictionAllowed: true,
    counterpartyAllowed: true,
    marketRulesValid: true,
    systemHealthy: true,
    contractPaused: false,
    assetEligible: true,
    assetRestricted: false,
    balanceSufficient: true,
    groundingCurrent: false,
    approvedSourceCurrent: false,
    quotedValue: "100",
    executions: "0",
    aggregateExposure: "0",
    openOrders: "0",
    exitSafe: true,
    nativeReviewDigest: plan.legs[0].nativeReviewDigest,
    nativeOperationCurrent: true,
    nativeApprovalsCurrent: true,
    nativeOfferCounterpartyAllowed: true,
  };
  return {
    user,
    request,
    nativePlan,
    policy,
    envelope,
    plan,
    observation,
    verified: validateActionAuthority(envelope, { ethers, policy }),
    authorize: createActionPolicy({ ethers, policy }),
  };
}
test("native NFT plan references bind existing list/offer/buy/accept/cancel shapes without raw caller calldata", async () => {
  for (const action of ["list", "offer", "buy", "accept", "cancel"])
    for (const chainId of ["1", "8453"]) {
      const f = await nftFixture(action, chainId),
        leg = f.plan.legs[0];
      assert.equal(
        f.authorize(f.envelope, leg, f.observation).state,
        "AUTHORIZED_NOT_EXECUTED",
      );
      assert.equal(Object.hasOwn(leg.dispatch.args, "data"), false);
      assert.equal(
        leg.dispatch.args.nativeOperationId,
        f.nativePlan.operationId,
      );
      assert.throws(
        () =>
          compileStage1Action(
            {
              ...f.request,
              terms: {
                nativeOperationId: "test-native-record",
                data: "0xdeadbeef",
              },
            },
            { ethers, chainId, nativePlan: f.nativePlan },
          ),
        /REFERENCE_INVALID/,
      );
      assert.throws(
        () =>
          f.authorize(f.envelope, leg, {
            ...f.observation,
            nativeReviewDigest: ethers.ZeroHash,
          }),
        /PLAN_NOT_CURRENT/,
      );
    }
});
test("unavailable or approval-only native plan cannot become autonomous wallet authority", async () => {
  const f = await nftFixture();
  assert.throws(
    () => compileStage1Action(f.request, { ethers, chainId: "1" }),
    /EXECUTION_ADAPTER_REQUIRED/,
  );
  assert.throws(
    () =>
      compileStage1Action(f.request, {
        ethers,
        chainId: "1",
        nativePlan: { ...f.nativePlan, kind: "approval" },
      }),
    /APPROVAL_AUTHORITY_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      compileStage1Action(f.request, {
        ethers,
        chainId: "560048",
        nativePlan: f.nativePlan,
      }),
    /PLAN_BINDING_REFUSED/,
  );
});
test("native accept-offer uses exact OrderFulfilled, transaction value and reviewed call identity", async () => {
  const f = await nftFixture(),
    leg = f.plan.legs[0],
    tx = ethers.id("TEST_TX"),
    block = ethers.id("TEST_BLOCK");
  const evidence = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    chainId: "1",
    sourceId: "OFFLINE_NATIVE_PLAN_FIXTURE",
    observedAt: Date.now(),
    callHash: leg.callHash,
    transaction: {
      hash: tx,
      to: leg.market,
      from: leg.wallet,
      callHash: leg.callHash,
      value: "0",
      status: 1,
      blockNumber: 1,
      blockHash: block,
    },
    canonicalBlockHash: block,
    finalizedBlockNumber: 2,
    events: [
      {
        name: "OrderFulfilled",
        address: leg.market,
        args: { orderHash: leg.orderKey, recipient: leg.wallet },
        index: 0,
        removed: false,
        transactionHash: tx,
        blockHash: block,
      },
    ],
  };
  assert.equal(verifyActionEvidence(leg, evidence).verified, true);
  for (const mutate of [
    (x) => (x.transaction.value = "1"),
    (x) => (x.events[0].args.orderHash = ethers.ZeroHash),
    (x) => (x.events[0].args.recipient = ethers.ZeroAddress),
  ]) {
    const bad = structuredClone(evidence);
    mutate(bad);
    assert.equal(verifyActionEvidence(leg, bad).state, "UNKNOWN");
  }
});
test("native listing publication remains order-visible, never a settlement receipt", async () => {
  const f = await nftFixture("list"),
    leg = f.plan.legs[0],
    result = verifyActionEvidence(leg, {
      mode: "TEST_ONLY_NO_REAL_VALUE",
      chainId: "1",
      sourceId: "OFFLINE_NATIVE_PLAN_FIXTURE",
      observedAt: Date.now(),
      callHash: leg.callHash,
      state: "ORDER_VISIBLE",
      orderHash: leg.orderKey,
      seller: leg.wallet,
      intentHash: leg.orderKey,
      orderBodyDigest: kernelRequestDigest(leg.dispatch.args),
    });
  assert.equal(result.verified, true);
  assert.equal(result.kind, "ORDER_PUBLICATION");
  assert.equal(Object.hasOwn(result, "transactionHash"), false);
});
