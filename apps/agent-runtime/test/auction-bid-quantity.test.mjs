// Synthetic auction observations and receipts only; no chain RPC or real value.
import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFixture,
  syntheticEvidence,
  ethers,
} from "./action-fixtures.mjs";
import { verifyActionEvidence } from "../../../scripts/agent/action-evidence.mjs";
import {
  ACTION_BITS,
  STAGE1_ABI,
} from "../../../scripts/agent/stage1-action-plans.mjs";

const terms = (f, patch = {}) => ({
  listingId: "77",
  bidAmount: "20",
  seller: f.seller.address,
  amount: "2",
  ...patch,
});
function observe(f, leg, amountRemaining = "2", patch = {}) {
  const o = f.observe(leg);
  return { ...o, auction: { ...o.auction, amountRemaining }, ...patch };
}

for (const action of ["BID", "REBID"]) {
  test(`${action} prices the observed multi-unit lot while preserving total payment and native ABI`, async () => {
    const f = await actionFixture({
      kind: "AUCTION",
      action,
      intentPatch: { minUnitPrice: "10", maxUnitPrice: "10" },
    });
    const plan = f.compile(terms(f)),
      leg = plan.legs[0];
    assert.equal(leg.quantity, "2");
    assert.equal(leg.unitPrice, "10");
    assert.equal(leg.value, "20");
    assert.equal(leg.dispatch.method, "placeBid");
    assert.deepEqual(leg.dispatch.args, ["77", "20"]);
    const iface = new ethers.Interface(STAGE1_ABI.AUCTION);
    assert.equal(
      ethers.keccak256(iface.encodeFunctionData("placeBid", ["77", "20"])),
      leg.callHash,
    );
    assert.equal(f.authorize(f.envelope, leg, observe(f, leg)).value, "20");
    const evidence = syntheticEvidence(leg, plan.operationId);
    assert.equal(evidence.events[0].args.amount, "20");
    assert.equal(verifyActionEvidence(leg, evidence).verified, true);
    evidence.events[0].args.amount = "2";
    assert.equal(verifyActionEvidence(leg, evidence).state, "UNKNOWN");
  });
}

test("legacy three-field bids remain single-unit and still require the observed lot quantity", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "BID" });
  const { amount, ...legacy } = terms(f);
  const leg = f.compile(legacy).legs[0];
  assert.equal(leg.quantity, "1");
  assert.equal(leg.unitPrice, "20");
  assert.equal(f.authorize(f.envelope, leg, observe(f, leg, "1")).value, "20");
  assert.throws(
    () => f.authorize(f.envelope, leg, observe(f, leg, "2")),
    /AUCTION_BID_REFUSED/,
  );
  const missing = observe(f, leg, "1");
  delete missing.auction.amountRemaining;
  assert.throws(
    () => f.authorize(f.envelope, leg, missing),
    /AUCTION_BID_REFUSED/,
  );
});

test("untrusted, missing or changed listing quantity never establishes the expected lot", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "BID" });
  const leg = f.compile(terms(f)).legs[0];
  for (const amount of [
    undefined,
    null,
    2,
    2n,
    "0",
    "1",
    "3",
    "02",
    "2.0",
    "-2",
    {},
  ]) {
    const o = observe(f, leg);
    o.auction.amountRemaining = amount;
    assert.throws(() => f.authorize(f.envelope, leg, o), /AUCTION_BID_REFUSED/);
  }
  for (const patch of [
    { seller: f.user.address },
    { asset: f.payment },
    { paymentToken: f.asset },
    { listingId: "78" },
    { state: "CANCELLED" },
  ]) {
    const o = observe(f, leg);
    Object.assign(o.auction, patch);
    assert.throws(() => f.authorize(f.envelope, leg, o), /AUCTION_BID_REFUSED/);
  }
  assert.throws(() =>
    f.authorize(
      f.envelope,
      leg,
      observe(f, leg, "2", { observedAt: Date.now() - 20000 }),
    ),
  );
});

test("bid unit bounds compare exact totals so ceiling division cannot hide an underpriced lot", async () => {
  const strict = await actionFixture({
    kind: "AUCTION",
    action: "BID",
    intentPatch: { minUnitPrice: "10", maxUnitPrice: "10" },
  });
  for (const bidAmount of ["19", "21"]) {
    const leg = strict.compile(terms(strict, { bidAmount })).legs[0];
    assert.throws(
      () => strict.authorize(strict.envelope, leg, observe(strict, leg)),
      /FINANCIAL_BOUND_EXCEEDED/,
    );
  }
  const allowed = await actionFixture({
    kind: "AUCTION",
    action: "BID",
    intentPatch: { minUnitPrice: "9", maxUnitPrice: "10" },
  });
  const leg = allowed.compile(terms(allowed, { bidAmount: "19" })).legs[0];
  assert.equal(leg.unitPrice, "10");
  assert.equal(
    allowed.authorize(allowed.envelope, leg, observe(allowed, leg)).value,
    "19",
  );
});

test("expected bid quantity is canonical, positive, bounded and does not admit extra request fields", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "BID" });
  for (const amount of [
    undefined,
    null,
    2,
    "0",
    "02",
    "-1",
    "1.5",
    "",
    (2n ** 256n).toString(),
  ]) {
    assert.throws(() => f.compile(terms(f, { amount })), /ACTION_UINT_INVALID/);
  }
  assert.throws(
    () => f.compile(terms(f, { amountRemaining: "2" })),
    /ACTION_TERMS_INVALID/,
  );
  const largest = f.compile(terms(f, { amount: (2n ** 256n - 1n).toString() }))
    .legs[0];
  assert.equal(largest.unitPrice, "1");
});

test("multi-unit bid budgets and adverse slippage continue to charge total payment", async () => {
  for (const [intentPatch, observationPatch, expected] of [
    [{ maxTransactionValue: "19" }, {}, /FINANCIAL_BOUND_EXCEEDED/],
    [
      { maxAggregateExposure: "20" },
      { aggregateExposure: "1" },
      /EXPOSURE_EXCEEDED/,
    ],
    [{}, { quotedValue: "19" }, /SLIPPAGE_EXCEEDED/],
    [{ maxExecutions: "1" }, { executions: "1" }, /AUTHORITY_CONSUMED/],
  ]) {
    const f = await actionFixture({
      kind: "AUCTION",
      action: "BID",
      intentPatch,
    });
    const leg = f.compile(terms(f)).legs[0];
    assert.throws(
      () =>
        f.authorize(f.envelope, leg, observe(f, leg, "2", observationPatch)),
      expected,
    );
  }
});

test("multi-unit bids retain revocation, action scope, current window and rebid proof checks", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "REBID" });
  const leg = f.compile(terms(f)).legs[0];
  assert.throws(() =>
    f.authorize(f.envelope, leg, observe(f, leg, "2", { revoked: true })),
  );
  assert.throws(
    () => f.authorize(f.envelope, leg, observe(f, leg), { suspended: true }),
    /NEW_ACTIVITY_SUSPENDED/,
  );
  for (const patch of [
    { priorBidByWallet: false },
    { minimumBid: "21" },
    { startsAt: String(Math.floor(Date.now() / 1000) + 60) },
    { endsAt: String(Math.floor(Date.now() / 1000) - 1) },
  ]) {
    const o = observe(f, leg);
    Object.assign(o.auction, patch);
    assert.throws(() => f.authorize(f.envelope, leg, o), /AUCTION_BID_REFUSED/);
  }
  const restricted = await actionFixture({
    kind: "AUCTION",
    action: "BID",
    intentPatch: { actionScope: ACTION_BITS.BUY.toString() },
  });
  const refused = restricted.compile(terms(restricted)).legs[0];
  assert.throws(() =>
    restricted.authorize(
      restricted.envelope,
      refused,
      observe(restricted, refused),
    ),
  );
});
