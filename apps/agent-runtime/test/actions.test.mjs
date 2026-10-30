import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFixture,
  syntheticEvidence,
  ethers,
} from "./action-fixtures.mjs";
import { verifyActionEvidence } from "../../../scripts/agent/action-evidence.mjs";
import {
  compileStage1Action,
  ACTION_BITS,
} from "../../../scripts/agent/stage1-action-plans.mjs";
import { validateActionAuthority } from "../../../scripts/agent/action-policy.mjs";
import { INTENT_TYPES } from "../../../scripts/agent/bounded-intent.mjs";

test("A2 signed minimum schema permits multiple bounded executions and rejects widened signature", async () => {
  const f = await actionFixture({ intentPatch: { maxExecutions: "4" } });
  assert.equal(f.verified.envelope.intent.maxExecutions, "4");
  const changed = structuredClone(f.envelope);
  changed.intent.maxExecutions = "5";
  assert.throws(
    () => validateActionAuthority(changed, { ethers, policy: f.policy }),
    /SIGNATURE_INVALID/,
  );
});
test("native fractional partial-fill plan uses exact ABI/seller signature and unit/value limits", async () => {
  const f = await actionFixture();
  const quote = await f.order();
  const plan = f.compile({ ...quote, quantity: "3" }),
    leg = plan.legs[0];
  assert.equal(leg.dispatch.method, "fillIntent");
  assert.equal(leg.value, "30");
  assert.equal(f.authorize(f.envelope, leg, f.observe(leg)).value, "30");
  assert.throws(
    () => f.compile({ ...quote, quantity: "11" }),
    /FILL_SCOPE_REFUSED/,
  );
  const bad = structuredClone(quote);
  bad.intent.unitPrice = "1";
  assert.throws(() => f.compile({ ...bad, quantity: "1" }), /BINDING_REFUSED/);
  for (const patch of [
    { groundingCurrent: false },
    { approvedSourceCurrent: false },
    { assetRestricted: true },
    { observedAt: Date.now() - 20000 },
    { revoked: true },
    { orderRemaining: "2" },
    { contractPaused: true },
  ])
    assert.throws(() => f.authorize(f.envelope, leg, f.observe(leg, patch)));
});
test("native whole purchase and exact receipt event binding are separate from request acceptance", async () => {
  const f = await actionFixture({ kind: "WHOLE", action: "BUY" }),
    plan = f.compile({ ...(await f.order()), quantity: "1" }),
    leg = plan.legs[0];
  assert.equal(
    f.authorize(f.envelope, leg, f.observe(leg)).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  const evidence = syntheticEvidence(leg, plan.operationId);
  assert.equal(verifyActionEvidence(leg, evidence).verified, true);
  for (const mutate of [
    (x) => (x.transaction.from = f.seller.address),
    (x) => (x.canonicalBlockHash = ethers.ZeroHash),
    (x) => (x.events[0].args.price = "1"),
    (x) => (x.events[0].removed = true),
    (x) => x.events.push(x.events[0]),
  ]) {
    const bad = structuredClone(evidence);
    mutate(bad);
    assert.equal(verifyActionEvidence(leg, bad).state, "UNKNOWN");
  }
});
test("create/amend/cancel signed orders enforce retire-before-replace and exact signed terms", async () => {
  const f = await actionFixture({ action: "CREATE_ORDER" }),
    original = await f.order({ owner: f.user }),
    replacement = await f.order({ owner: f.user, salt: "2" });
  const created = f.compile(original);
  assert.equal(created.legs[0].dispatch.kind, "SIGNED_ORDER_PUBLICATION");
  const amend = f.compile({ original, replacement }, { action: "AMEND_ORDER" });
  assert.deepEqual(
    amend.legs.map((x) => x.name),
    ["RETIRE", "REPLACE"],
  );
  assert.throws(
    () => f.authorize(f.envelope, amend.legs[1], f.observe(amend.legs[1])),
    /PRIOR_ACTION_UNCONFIRMED/,
  );
  assert.equal(
    f.authorize(f.envelope, amend.legs[1], f.observe(amend.legs[1]), {
      priorLegs: [
        { name: "RETIRE", state: "COMPLETED", proof: { verified: true } },
      ],
    }).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  const cancel = f.compile(original, { action: "CANCEL_ORDER" });
  assert.equal(
    f.authorize(
      f.envelope,
      cancel.legs[0],
      f.observe(cancel.legs[0], {
        systemHealthy: false,
        contractPaused: true,
        groundingCurrent: false,
        approvedSourceCurrent: false,
      }),
      { suspended: true },
    ).value,
    "0",
  );
  assert.throws(
    () =>
      f.compile({ original, replacement: original }, { action: "AMEND_ORDER" }),
    /AMENDMENT_BINDING_REFUSED/,
  );
});
test("auction create, bid, rebid, cancellation and settlement have distinct native event rules", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "BID" });
  const plans = [
    f.compile({ listingId: "77", bidAmount: "10", seller: f.seller.address }),
    f.compile(
      { listingId: "77", bidAmount: "20", seller: f.seller.address },
      { action: "REBID" },
    ),
    f.compile({ listingId: "77" }, { action: "CANCEL_ORDER" }),
    f.compile(
      { listingId: "77", buyer: f.user.address, payment: "20" },
      { action: "SETTLE" },
    ),
    f.compile({ amount: "20" }, { action: "REFUND" }),
  ];
  for (const plan of plans) {
    const leg = plan.legs[0];
    let observation = f.observe(leg);
    if (leg.name === "CANCEL") observation.auction.seller = f.user.address;
    if (leg.name === "SETTLE")
      observation.auction.endsAt = String(Math.floor(Date.now() / 1000) - 1);
    assert.equal(
      f.authorize(f.envelope, leg, observation).state,
      "AUTHORIZED_NOT_EXECUTED",
    );
    assert.equal(
      verifyActionEvidence(leg, syntheticEvidence(leg, plan.operationId))
        .verified,
      true,
    );
  }
  const bid = plans[0].legs[0],
    bad = f.observe(bid);
  bad.auction.minimumBid = "11";
  assert.throws(() => f.authorize(f.envelope, bid, bad), /AUCTION_BID_REFUSED/);
  const rebid = plans[1].legs[0],
    first = f.observe(rebid);
  first.auction.priorBidByWallet = false;
  assert.throws(
    () => f.authorize(f.envelope, rebid, first),
    /AUCTION_BID_REFUSED/,
  );
  const created = f.compile(
    {
      requestId: ethers.id("TEST_AUCTION_CREATE"),
      amount: "1",
      openingBid: "10",
      startsAt: String(Math.floor(Date.now() / 1000) - 1),
      endsAt: String(Math.floor(Date.now() / 1000) + 60),
      reservePrice: "10",
      minimumBidIncrement: "1",
      extensionWindow: "10",
      extensionDuration: "10",
    },
    { action: "CREATE_ORDER" },
  );
  assert.equal(created.legs[0].dispatch.method, "createAuctionListing");
  assert.equal(
    verifyActionEvidence(
      created.legs[0],
      syntheticEvidence(created.legs[0], created.operationId),
    ).verified,
    true,
  );
});
test("offering claims/refunds and auction credit withdrawals preserve exits during pause", async () => {
  for (const action of ["CLAIM", "REFUND"]) {
    const f = await actionFixture({ kind: "OFFERING", action }),
      plan = f.compile({ offeringId: "4", amount: "30" }),
      leg = plan.legs[0];
    const observation = f.observe(leg, {
      systemHealthy: false,
      contractPaused: true,
      groundingCurrent: false,
      approvedSourceCurrent: false,
    });
    assert.equal(
      f.authorize(f.envelope, leg, observation, { suspended: true }).value,
      "0",
    );
    assert.equal(
      verifyActionEvidence(leg, syntheticEvidence(leg, plan.operationId))
        .verified,
      true,
    );
    observation.offering.successful = !observation.offering.successful;
    assert.throws(
      () => f.authorize(f.envelope, leg, observation),
      /OFFERING_EXIT_UNAVAILABLE/,
    );
  }
});
test("A10 constitutional mutation and unsupported NFT delegated execution never gain authority", async () => {
  const f = await actionFixture();
  const quote = await f.order();
  const plan = f.compile({ ...quote, quantity: "1" });
  assert.throws(
    () =>
      compileStage1Action(
        { ...plan.request, action: "REPLACE_SOURCE_REGISTRY" },
        { ethers },
      ),
    /REQUEST_INVALID/,
  );
  assert.throws(
    () =>
      compileStage1Action(
        {
          ...plan.request,
          marketKind: "NFT",
          action: "ACCEPT_OFFER",
          terms: { nativeOperationId: "test-only-nft" },
        },
        { ethers },
      ),
    /NATIVE_NFT_EXECUTION_ADAPTER_REQUIRED/,
  );
  const intent = {
    ...f.envelope.intent,
    actionScope: ACTION_BITS.BUY.toString(),
  };
  const envelope = {
    ...f.envelope,
    intent,
    signature: await f.user.signTypedData(
      f.envelope.domain,
      INTENT_TYPES,
      intent,
    ),
  };
  assert.throws(
    () => f.authorize(envelope, plan.legs[0], f.observe(plan.legs[0])),
    /ACTION_SCOPE_REFUSED/,
  );
});

test("A2 expired, revoked and observation nonce/principal drift are rejected before execution", async () => {
  const f = await actionFixture(),
    plan = f.compile({ ...(await f.order()), quantity: "1" }),
    leg = plan.legs[0];
  for (const patch of [
    { revoked: true },
    { nonceAvailable: false },
    { authority: { ...f.observe(leg).authority, nonce: "2" } },
    { authority: { ...f.observe(leg).authority, wallet: f.seller.address } },
    { sourceId: "UNAPPROVED_OBSERVATION_PRODUCER" },
  ])
    assert.throws(() => f.authorize(f.envelope, leg, f.observe(leg, patch)));
  const now = Math.floor(Date.now() / 1000),
    expired = await actionFixture({
      intentPatch: {
        validFrom: String(now - 120),
        validUntil: String(now - 60),
      },
    }),
    old = expired.compile({ ...(await expired.order()), quantity: "1" });
  assert.throws(
    () =>
      expired.authorize(
        expired.envelope,
        old.legs[0],
        expired.observe(old.legs[0]),
      ),
    /INTENT_NOT_CURRENT/,
  );
});

test("reusable action layer supports a configured bounded profile without granting an execution adapter", async () => {
  const f = await actionFixture(),
    quote = await f.order();
  const { createActionPolicy } =
    await import("../../../scripts/agent/action-policy.mjs");
  const policy = { ...f.policy, mode: "BOUNDED_SIGNED_AUTHORITY" },
    plan = compileStage1Action(
      { ...f.compile({ ...quote, quantity: "1" }).request },
      { ethers, mode: policy.mode },
    );
  assert.equal(plan.mode, "BOUNDED_SIGNED_AUTHORITY");
  assert.equal(
    createActionPolicy({ ethers, policy })(
      f.envelope,
      plan.legs[0],
      f.observe(plan.legs[0]),
    ).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
});
