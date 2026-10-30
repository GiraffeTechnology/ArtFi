import { nftPaymentAddress } from "../../../scripts/native-nft-currency.mjs";
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
    payment = nftPaymentAddress(
      chainId,
      ["buy", "list"].includes(nativeAction) ? "ETH" : "WETH",
    ),
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

const taskFields = [
  "kind",
  "taskId",
  "taskDigest",
  "executorDigest",
  "grantReference",
  "grantPolicyVersion",
  "operationId",
];
async function taskListingFixture() {
  const f = await nftFixture("list");
  delete f.nativePlan.sessionId;
  f.nativePlan.taskPrincipal = {
    kind: "task",
    taskId: "offline-task:listing",
    taskDigest: ethers.id("OFFLINE_TASK"),
    executorDigest: ethers.id("OFFLINE_EXECUTOR"),
    grantReference: "grant:offline_listing",
    grantPolicyVersion: "1",
    operationId: "offline-listing:1",
  };
  f.plan = compileStage1Action(f.request, {
    ethers,
    chainId: "1",
    nativePlan: f.nativePlan,
  });
  f.observation.nativeReviewDigest = f.plan.legs[0].nativeReviewDigest;
  f.observation.nativeTaskPrincipal = structuredClone(
    f.nativePlan.taskPrincipal,
  );
  return f;
}
function taskPublication(f) {
  const leg = f.plan.legs[0];
  return {
    mode: leg.mode,
    chainId: leg.chainId,
    sourceId: "OFFLINE_NATIVE_PLAN_FIXTURE",
    observedAt: Date.now(),
    callHash: leg.callHash,
    state: "ORDER_VISIBLE",
    orderHash: leg.orderKey,
    seller: leg.wallet,
    intentHash: leg.orderKey,
    orderBodyDigest: kernelRequestDigest(leg.dispatch.args),
    nativeTaskPrincipal: structuredClone(leg.nativeTaskPrincipal),
  };
}

test("task listing compilation retains the complete native journal principal in durable plan and dispatch", async () => {
  const f = await taskListingFixture(),
    leg = f.plan.legs[0];
  assert.deepEqual(leg.nativeTaskPrincipal, f.nativePlan.taskPrincipal);
  assert.deepEqual(leg.dispatch.args.taskPrincipal, f.nativePlan.taskPrincipal);
  assert.deepEqual(
    Object.keys(leg.nativeTaskPrincipal).sort(),
    [...taskFields].sort(),
  );
  assert.equal(leg.nativeReviewDigest, kernelRequestDigest(f.nativePlan));
  assert.equal(leg.callHash, kernelRequestDigest(leg.dispatch));
  assert.equal(
    f.authorize(f.envelope, leg, f.observation).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  f.nativePlan.taskPrincipal.grantReference = "grant:other";
  assert.equal(leg.nativeTaskPrincipal.grantReference, "grant:offline_listing");
});

test("task plans refuse malformed, partial, mixed session and unsupported native action principals", async () => {
  const f = await taskListingFixture();
  const invalid = [
    (p) => delete p.taskPrincipal.taskId,
    (p) => delete p.taskPrincipal.taskDigest,
    (p) => delete p.taskPrincipal.executorDigest,
    (p) => delete p.taskPrincipal.grantReference,
    (p) => delete p.taskPrincipal.grantPolicyVersion,
    (p) => delete p.taskPrincipal.operationId,
    (p) => (p.taskPrincipal.kind = "session"),
    (p) => (p.taskPrincipal.extra = "not-a-journal-field"),
    (p) => (p.taskPrincipal = null),
    (p) => (p.taskPrincipal.taskId = ""),
    (p) => (p.taskPrincipal.operationId = "invalid/operation"),
    (p) => (p.taskPrincipal.taskDigest = "0x1234"),
    (p) => (p.taskPrincipal.executorDigest = ethers.id("UPPER").toUpperCase()),
    (p) => (p.taskPrincipal.grantReference = "other:grant"),
    (p) => (p.taskPrincipal.grantPolicyVersion = "0"),
    (p) => (p.taskPrincipal.grantPolicyVersion = "01"),
    (p) => (p.taskPrincipal.grantPolicyVersion = (2n ** 256n).toString()),
    (p) => (p.sessionId = "session"),
    (p) => (p.sessionId = undefined),
  ];
  for (const mutate of invalid) {
    const p = structuredClone(f.nativePlan);
    mutate(p);
    assert.throws(
      () =>
        compileStage1Action(f.request, { ethers, chainId: "1", nativePlan: p }),
      /NATIVE_NFT_TASK_(PRINCIPAL_INVALID|PLAN_BINDING_REFUSED)/,
    );
  }
  for (const action of ["offer", "buy", "accept", "cancel"]) {
    const legacy = await nftFixture(action);
    delete legacy.nativePlan.sessionId;
    legacy.nativePlan.taskPrincipal = structuredClone(
      f.nativePlan.taskPrincipal,
    );
    assert.throws(
      () =>
        compileStage1Action(legacy.request, {
          ethers,
          chainId: "1",
          nativePlan: legacy.nativePlan,
        }),
      /NATIVE_NFT_TASK_PLAN_BINDING_REFUSED/,
    );
  }
});

test("every task principal field is checked before dispatch and during publication recovery", async () => {
  const f = await taskListingFixture(),
    leg = f.plan.legs[0];
  const replacements = {
    kind: "session",
    taskId: "other-task",
    taskDigest: ethers.id("OTHER_TASK"),
    executorDigest: ethers.id("OTHER_EXECUTOR"),
    grantReference: "grant:other",
    grantPolicyVersion: "2",
    operationId: "other-operation",
  };
  for (const field of taskFields) {
    const observation = structuredClone(f.observation);
    observation.nativeTaskPrincipal[field] = replacements[field];
    assert.throws(
      () => f.authorize(f.envelope, leg, observation),
      /TASK_PRINCIPAL_MISMATCH/,
    );
    const evidence = taskPublication(f);
    evidence.nativeTaskPrincipal[field] = replacements[field];
    assert.equal(
      verifyActionEvidence(leg, evidence).reason,
      "NATIVE_NFT_TASK_PRINCIPAL_MISMATCH",
    );
  }
});

test("a task-bound record cannot downgrade to omitted identity or a different dispatch principal", async () => {
  const f = await taskListingFixture(),
    leg = f.plan.legs[0];
  for (const missing of [undefined, null, {}]) {
    assert.throws(
      () =>
        f.authorize(f.envelope, leg, {
          ...f.observation,
          nativeTaskPrincipal: missing,
        }),
      /TASK_PRINCIPAL_MISMATCH/,
    );
    assert.equal(
      verifyActionEvidence(leg, {
        ...taskPublication(f),
        nativeTaskPrincipal: missing,
      }).state,
      "UNKNOWN",
    );
  }
  for (const mutate of [
    (l) => delete l.nativeTaskPrincipal,
    (l) => delete l.dispatch.args.taskPrincipal,
    (l) => (l.dispatch.args.taskPrincipal.operationId = "other-operation"),
  ]) {
    const changed = structuredClone(leg);
    // Clone projections independently so a one-sided substitution is tested even
    // when structuredClone preserves shared object references in the plan.
    changed.nativeTaskPrincipal = structuredClone(leg.nativeTaskPrincipal);
    mutate(changed);
    assert.throws(
      () => f.authorize(f.envelope, changed, f.observation),
      /TASK_PRINCIPAL_MISMATCH/,
    );
    assert.equal(
      verifyActionEvidence(changed, taskPublication(f)).state,
      "UNKNOWN",
    );
  }
});

test("canonical principal key order is irrelevant and legacy session references gain no task authority", async () => {
  const f = await taskListingFixture(),
    leg = f.plan.legs[0];
  const reversed = Object.fromEntries(
    Object.entries(leg.nativeTaskPrincipal).reverse(),
  );
  assert.equal(
    f.authorize(f.envelope, leg, {
      ...f.observation,
      nativeTaskPrincipal: reversed,
    }).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  assert.equal(
    verifyActionEvidence(leg, {
      ...taskPublication(f),
      nativeTaskPrincipal: reversed,
    }).verified,
    true,
  );
  const legacy = await nftFixture("list");
  assert.equal(
    Object.hasOwn(legacy.plan.legs[0], "nativeTaskPrincipal"),
    false,
  );
  assert.equal(
    Object.hasOwn(legacy.plan.legs[0].dispatch.args, "taskPrincipal"),
    false,
  );
  assert.throws(
    () =>
      legacy.authorize(legacy.envelope, legacy.plan.legs[0], {
        ...legacy.observation,
        nativeTaskPrincipal: reversed,
      }),
    /TASK_PRINCIPAL_MISMATCH/,
  );
});

test("expired task review remains readable with its exact principal and proves publication only", async () => {
  const f = await taskListingFixture(),
    leg = f.plan.legs[0];
  leg.nativePlanExpiresAt = 0;
  assert.throws(
    () => f.authorize(f.envelope, leg, f.observation),
    /PLAN_NOT_CURRENT/,
  );
  const proof = verifyActionEvidence(leg, taskPublication(f));
  assert.equal(proof.verified, true);
  assert.equal(proof.kind, "ORDER_PUBLICATION");
  assert.deepEqual(proof.nativeTaskPrincipal, leg.nativeTaskPrincipal);
  assert.equal(Object.hasOwn(proof, "transactionHash"), false);
  assert.equal(Object.hasOwn(proof, "saleComplete"), false);
});

test("durable started and unknown task listings reconcile exact identity without another execute call", async () => {
  const { createActionKernel } =
    await import("../../../scripts/agent/action-kernel.mjs");
  for (const initial of ["STARTED", "UNKNOWN", "SUBMITTED"]) {
    const f = await taskListingFixture();
    let row = {
      id: f.plan.operationId,
      authorityKey: "OFFLINE_TASK_AUTHORITY",
      envelope: f.envelope,
      intentDigest: f.verified.digest,
      plan: f.plan,
      cursor: 0,
      legs: [{ state: initial }],
      state: "SAFE_DEGRADED",
      version: 1,
      leaseToken: "OFFLINE_RECOVERY",
      leaseExpiresAt: Date.now() + 10000,
    };
    let sends = 0,
      authorizationCalls = 0,
      reads = 0,
      exactEvidence = false;
    const update = (state) =>
      (row = { ...row, state, version: row.version + 1 });
    const store = {
      leaseDurationMs: 10000,
      operationTimeoutMs: 250,
      totalOperationTimeoutMs: 400,
      claim: async () => row,
      renew: async () =>
        (row = { ...row, leaseExpiresAt: row.leaseExpiresAt + 1 }),
      startLeg: async () => {
        throw Error("UNEXPECTED_NEW_START");
      },
      submitted: async () => {
        throw Error("UNEXPECTED_NEW_SUBMISSION");
      },
      completeLeg: async (_id, version, token, proof) => {
        assert.equal(version, row.version);
        assert.equal(token, row.leaseToken);
        assert.deepEqual(
          proof.nativeTaskPrincipal,
          f.plan.legs[0].nativeTaskPrincipal,
        );
        return update("COMPLETED");
      },
      degrade: async () => update("SAFE_DEGRADED"),
      reject: async () => {
        throw Error("UNEXPECTED_REJECTION");
      },
      release: async () => {},
    };
    const tick = createActionKernel({
      store,
      adapterTimeoutMs: 100,
      authorize: async () => {
        authorizationCalls++;
        throw Error("UNEXPECTED_AUTHORIZATION");
      },
      observe: async () => {
        throw Error("UNEXPECTED_NEW_OBSERVATION");
      },
      execute: async () => {
        sends++;
        throw Error("UNEXPECTED_EXECUTE");
      },
      readEvidence: async (leg, context) => {
        reads++;
        assert.deepEqual(
          leg.nativeTaskPrincipal,
          f.plan.legs[0].nativeTaskPrincipal,
        );
        assert.equal(context.id, row.id);
        const evidence = taskPublication(f);
        if (!exactEvidence) delete evidence.nativeTaskPrincipal;
        return evidence;
      },
    });
    assert.equal((await tick(row.id)).state, "SAFE_DEGRADED");
    assert.equal(sends, 0);
    exactEvidence = true;
    assert.equal((await tick(row.id)).state, "COMPLETED");
    assert.equal(sends, 0);
    assert.equal(authorizationCalls, 0);
    assert.equal(reads, 2);
  }
});
