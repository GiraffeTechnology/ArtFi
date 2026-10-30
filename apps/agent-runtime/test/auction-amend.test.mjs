// Isolated action/chain records only. These cases do not use a network signer,
// create an on-chain auction or claim live marketplace acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFixture,
  syntheticEvidence,
  ethers,
} from "./action-fixtures.mjs";
import {
  ACTION_BITS,
  STAGE1_ABI,
} from "../../../scripts/agent/stage1-action-plans.mjs";
import { verifyActionEvidence } from "../../../scripts/agent/action-evidence.mjs";

function replacementTerms() {
  const now = Math.floor(Date.now() / 1000);
  return {
    requestId: ethers.id("OFFLINE_AUCTION_REPLACEMENT"),
    amount: "2",
    openingBid: "20",
    startsAt: String(now - 1),
    endsAt: String(now + 120),
    reservePrice: "25",
    minimumBidIncrement: "1",
    extensionWindow: "10",
    extensionDuration: "10",
  };
}
async function fixture() {
  const f = await actionFixture({
    kind: "AUCTION",
    action: "AMEND_ORDER",
    intentPatch: { actionScope: ACTION_BITS.AMEND_ORDER.toString() },
  });
  const terms = { listingId: "77", replacement: replacementTerms() };
  const plan = f.compile(terms);
  const proof = verifyActionEvidence(
    plan.legs[0],
    syntheticEvidence(plan.legs[0], plan.operationId, 0),
  );
  assert.equal(proof.verified, true);
  const priorLegs = [{ name: "CANCEL", state: "COMPLETED", proof }];
  const observe = (leg) =>
    f.observe(leg, {
      auction: {
        ...f.observe(leg).auction,
        state: leg.exit ? "ACTIVE" : "CANCELLED",
        listingId: "77",
        seller: f.user.address,
        hasBid: false,
      },
    });
  return { f, terms, plan, priorLegs, observe };
}

test("auction amendment compiles only native cancel then create with one AMEND scope", async () => {
  const { f, terms, plan, priorLegs, observe } = await fixture();
  const [cancel, replace] = plan.legs;
  assert.deepEqual(
    plan.legs.map((leg) => leg.name),
    ["CANCEL", "REPLACE"],
  );
  assert.equal(cancel.exit, true);
  assert.equal(cancel.value, "0");
  assert.equal(replace.dependsOn, "CANCEL");
  assert.equal(replace.replacesOrderKey, "77");
  assert.equal(replace.opensOrder, true);
  assert.equal(replace.orderKey, terms.replacement.requestId);
  assert.equal(replace.unitPrice, "10");
  assert.equal(replace.value, "20");
  const abi = new ethers.Interface(STAGE1_ABI.AUCTION);
  for (const leg of plan.legs) {
    assert.equal(leg.action, "AMEND_ORDER");
    assert.equal(leg.dispatch.kind, "CONTRACT_CALL");
    const decoded = abi.parseTransaction({
      data: abi.encodeFunctionData(leg.dispatch.method, leg.dispatch.args),
    });
    assert.equal(decoded.name, leg.dispatch.method);
    assert.equal(
      f.authorize(f.envelope, leg, observe(leg), { priorLegs }).state,
      "AUTHORIZED_NOT_EXECUTED",
    );
  }
  assert.deepEqual(replace.dispatch.args, [
    terms.replacement.requestId,
    f.asset,
    f.payment,
    "2",
    "20",
    terms.replacement.startsAt,
    terms.replacement.endsAt,
    "25",
    "1",
    "10",
    "10",
  ]);
});

test("invalid replacement terms are refused before an auction cancellation workflow is compiled", async () => {
  const { f, terms } = await fixture();
  for (const mutate of [
    (t) => (t.listingId = "0"),
    (t) => (t.extra = true),
    (t) => delete t.replacement,
    (t) => (t.replacement.data = "0xdeadbeef"),
    (t) => (t.replacement.requestId = ethers.ZeroHash),
    (t) => (t.replacement.amount = "0"),
    (t) => (t.replacement.reservePrice = "19"),
    (t) => (t.replacement.startsAt = t.replacement.endsAt),
    (t) => (t.replacement.extensionWindow = "1000"),
    (t) => (t.replacement.extensionDuration = "0"),
    (t) => (t.replacement.endsAt = (2n ** 48n).toString()),
  ]) {
    const bad = structuredClone(terms);
    mutate(bad);
    assert.throws(
      () => f.compile(bad),
      /ACTION_TERMS_INVALID|ACTION_UINT_INVALID|AUCTION_(WINDOW|RESERVE_PRICE)_INVALID/,
    );
  }
  for (const patch of [
    { requestId: ethers.ZeroHash },
    { reservePrice: "0" },
    { extensionWindow: "1000" },
  ]) {
    assert.throws(
      () =>
        f.compile(
          { ...terms.replacement, ...patch },
          { action: "CREATE_ORDER" },
        ),
      /ACTION_TERMS_INVALID|AUCTION_(WINDOW|RESERVE_PRICE)_INVALID/,
    );
  }
});

test("auction retirement still requires the exact active seller asset currency and no bids", async () => {
  const { f, plan, observe } = await fixture(),
    leg = plan.legs[0];
  for (const patch of [
    { state: "SETTLED" },
    { listingId: "78" },
    { seller: f.seller.address },
    { asset: ethers.ZeroAddress },
    { paymentToken: ethers.ZeroAddress },
    { hasBid: true },
  ]) {
    const o = observe(leg);
    Object.assign(o.auction, patch);
    assert.throws(
      () => f.authorize(f.envelope, leg, o),
      /AUCTION_CANCEL_REFUSED/,
    );
  }
});

test("replacement cannot start from an absent unknown or unrelated cancellation proof", async () => {
  const { f, plan, observe, priorLegs } = await fixture(),
    leg = plan.legs[1];
  assert.throws(
    () => f.authorize(f.envelope, leg, observe(leg)),
    /PRIOR_ACTION_UNCONFIRMED/,
  );
  for (const mutate of [
    (p) => (p[0].state = "UNKNOWN"),
    (p) => (p[0].proof.verified = false),
    (p) => (p[0].proof.eventName = "OrderCancelled"),
    (p) => (p[0].proof.orderKey = "78"),
    (p) => (p[0].proof.eventArgs.listingId = "78"),
  ]) {
    const bad = structuredClone(priorLegs);
    mutate(bad);
    assert.throws(
      () => f.authorize(f.envelope, leg, observe(leg), { priorLegs: bad }),
      /PRIOR_ACTION_UNCONFIRMED|AUCTION_REPLACEMENT_UNCONFIRMED/,
    );
  }
});

test("replacement rechecks the cancelled listing identity and current retirement observation", async () => {
  const { f, plan, observe, priorLegs } = await fixture(),
    leg = plan.legs[1];
  for (const patch of [
    { state: "ACTIVE" },
    { listingId: "78" },
    { seller: f.seller.address },
    { asset: ethers.ZeroAddress },
    { paymentToken: ethers.ZeroAddress },
    { hasBid: true },
  ]) {
    const o = observe(leg);
    Object.assign(o.auction, patch);
    assert.throws(
      () => f.authorize(f.envelope, leg, o, { priorLegs }),
      /AUCTION_REPLACEMENT_UNCONFIRMED/,
    );
  }
  assert.throws(
    () =>
      f.authorize(
        f.envelope,
        leg,
        {
          ...observe(leg),
          originalOrderRetired: false,
        },
        { priorLegs },
      ),
    /PRIOR_ACTION_UNCONFIRMED/,
  );
});

test("auction replacement uses sell proceeds slippage and the original signed financial limits", async () => {
  const { f, plan, observe, priorLegs } = await fixture(),
    leg = plan.legs[1];
  assert.throws(
    () =>
      f.authorize(
        f.envelope,
        leg,
        {
          ...observe(leg),
          quotedValue: "21",
        },
        { priorLegs },
      ),
    /SLIPPAGE_EXCEEDED/,
  );
  assert.equal(
    f.authorize(
      f.envelope,
      leg,
      {
        ...observe(leg),
        quotedValue: "19",
      },
      { priorLegs },
    ).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  assert.throws(
    () =>
      f.authorize(f.envelope, { ...leg, value: "201" }, observe(leg), {
        priorLegs,
      }),
    /FINANCIAL_BOUND_EXCEEDED/,
  );
});

test("future auction creation is allowed before its start and expired creation remains refused", async () => {
  const { f, terms, priorLegs, observe } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  for (const action of ["CREATE_ORDER", "AMEND_ORDER"]) {
    const future = {
      ...terms.replacement,
      startsAt: String(now + 60),
      endsAt: String(now + 120),
    };
    const plan = f.compile(
      action === "CREATE_ORDER"
        ? future
        : {
            listingId: "77",
            replacement: future,
          },
      { action },
    );
    const leg = plan.legs.at(-1);
    // This case checks scheduling; the signed AMEND-only authority is preserved
    // in the separate amendment assertion, rather than expanded for creation.
    if (action === "AMEND_ORDER")
      assert.equal(
        f.authorize(f.envelope, leg, observe(leg), { priorLegs }).state,
        "AUTHORIZED_NOT_EXECUTED",
      );
    const expired = {
      ...future,
      startsAt: String(now - 120),
      endsAt: String(now - 60),
    };
    const old = f
      .compile(
        action === "CREATE_ORDER"
          ? expired
          : {
              listingId: "77",
              replacement: expired,
            },
        { action },
      )
      .legs.at(-1);
    if (action === "AMEND_ORDER")
      assert.throws(
        () => f.authorize(f.envelope, old, observe(old), { priorLegs }),
        /ORDER_NOT_CURRENT/,
      );
  }
  const create = await actionFixture({
    kind: "AUCTION",
    action: "CREATE_ORDER",
  });
  const leg = create.compile({
    ...terms.replacement,
    startsAt: String(now + 60),
    endsAt: String(now + 120),
  }).legs[0];
  assert.equal(
    create.authorize(create.envelope, leg, create.observe(leg)).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  const expired = create.compile({
    ...terms.replacement,
    startsAt: String(now - 120),
    endsAt: String(now - 60),
  }).legs[0];
  assert.throws(
    () => create.authorize(create.envelope, expired, create.observe(expired)),
    /ORDER_NOT_CURRENT/,
  );
});

test("suspension permits safe cancellation but cannot authorize the replacement", async () => {
  const { f, plan, observe, priorLegs } = await fixture();
  const unavailable = (leg) => ({
    ...observe(leg),
    systemHealthy: false,
    contractPaused: true,
    groundingCurrent: false,
    approvedSourceCurrent: false,
  });
  assert.equal(
    f.authorize(f.envelope, plan.legs[0], unavailable(plan.legs[0]), {
      suspended: true,
    }).state,
    "AUTHORIZED_NOT_EXECUTED",
  );
  assert.throws(
    () =>
      f.authorize(f.envelope, plan.legs[1], unavailable(plan.legs[1]), {
        priorLegs,
        suspended: true,
      }),
    /NEW_ACTIVITY_SUSPENDED/,
  );
});

test("removed or unfinalized cancellation events never unlock an auction replacement", async () => {
  const { f, plan, observe } = await fixture(),
    cancel = plan.legs[0],
    replace = plan.legs[1];
  for (const mutate of [
    (e) => (e.events[0].removed = true),
    (e) => (e.finalizedBlockNumber = 0),
    (e) => (e.events[0].args.listingId = "78"),
  ]) {
    const evidence = syntheticEvidence(cancel, plan.operationId, 0);
    mutate(evidence);
    const proof = verifyActionEvidence(cancel, evidence);
    assert.equal(proof.state, "UNKNOWN");
    assert.throws(
      () =>
        f.authorize(f.envelope, replace, observe(replace), {
          priorLegs: [{ name: "CANCEL", state: "COMPLETED", proof }],
        }),
      /PRIOR_ACTION_UNCONFIRMED|AUCTION_REPLACEMENT_UNCONFIRMED/,
    );
  }
});
