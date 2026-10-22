import test from "node:test";
import assert from "node:assert/strict";
import { actionFixture, ethers } from "./action-fixtures.mjs";
import { nftFixture } from "./native-nft-reference.test.mjs";
// Offline signed authority and synthetic observations only; no chain/provider calls.
const permitted = (fn) => assert.equal(fn().state, "AUTHORIZED_NOT_EXECUTED");
const refused = (fn) => assert.throws(fn, /SLIPPAGE_EXCEEDED/);
for (const kind of ["FRACTION", "WHOLE"]) {
  test(
    "A4 slippage rejects seller proceeds below the signed bound: " + kind,
    async () => {
      const f = await actionFixture({ kind, action: "CREATE_ORDER" });
      const p = f.compile(await f.order({ owner: f.user })),
        leg = p.legs[0];
      refused(() =>
        f.authorize(
          f.envelope,
          leg,
          f.observe(leg, { quotedValue: (BigInt(leg.value) + 1n).toString() }),
        ),
      );
    },
  );
  test("A4 slippage permits improved seller proceeds: " + kind, async () => {
    const f = await actionFixture({ kind, action: "CREATE_ORDER" });
    const leg = f.compile(await f.order({ owner: f.user })).legs[0];
    permitted(() =>
      f.authorize(
        f.envelope,
        leg,
        f.observe(leg, { quotedValue: (BigInt(leg.value) - 1n).toString() }),
      ),
    );
  });
  test(
    "A4 slippage enforces exact seller basis-point boundary: " + kind,
    async () => {
      const f = await actionFixture({
        kind,
        action: "CREATE_ORDER",
        intentPatch: { slippageLimit: "100" },
      });
      const leg = f.compile(
        await f.order({ owner: f.user, unitPrice: "99", maxAmount: "1" }),
      ).legs[0];
      permitted(() =>
        f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "100" })),
      );
      refused(() =>
        f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "101" })),
      );
    },
  );
  test(
    "A4 slippage checks the actual replacement after retirement: " + kind,
    async () => {
      const f = await actionFixture({ kind, action: "AMEND_ORDER" });
      const original = await f.order({ owner: f.user }),
        replacement = await f.order({ owner: f.user, salt: "2" });
      const plan = f.compile({ original, replacement });
      const leg = plan.legs[1];
      const context = {
        priorLegs: [
          { name: "RETIRE", state: "COMPLETED", proof: { verified: true } },
        ],
      };
      refused(() =>
        f.authorize(
          f.envelope,
          leg,
          f.observe(leg, { quotedValue: (BigInt(leg.value) + 1n).toString() }),
          context,
        ),
      );
      permitted(() =>
        f.authorize(
          f.envelope,
          leg,
          f.observe(leg, { quotedValue: (BigInt(leg.value) - 1n).toString() }),
          context,
        ),
      );
      permitted(() =>
        f.authorize(
          f.envelope,
          plan.legs[0],
          f.observe(plan.legs[0], { quotedValue: undefined }),
        ),
      );
    },
  );
}
test("A4 slippage applies seller direction to auction opening terms", async () => {
  const f = await actionFixture({ kind: "AUCTION", action: "CREATE_ORDER" });
  const now = Math.floor(Date.now() / 1000);
  const leg = f.compile({
    requestId: ethers.id("TEST_ONLY_SLIPPAGE_AUCTION"),
    amount: "1",
    openingBid: "100",
    startsAt: String(now - 1),
    endsAt: String(now + 60),
    reservePrice: "100",
    minimumBidIncrement: "1",
    extensionWindow: "10",
    extensionDuration: "10",
  }).legs[0];
  refused(() =>
    f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "101" })),
  );
  permitted(() =>
    f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "99" })),
  );
});
for (const action of ["list", "accept", "offer", "buy"]) {
  test(
    "A4 slippage derives native NFT price direction from compiled action: " +
      action,
    async () => {
      const f = await nftFixture(action),
        leg = f.plan.legs[0];
      const selling = ["list", "accept"].includes(action);
      refused(() =>
        f.authorize(f.envelope, leg, {
          ...f.observation,
          quotedValue: selling ? "101" : "99",
        }),
      );
      permitted(() =>
        f.authorize(f.envelope, leg, {
          ...f.observation,
          quotedValue: selling ? "99" : "101",
        }),
      );
      permitted(() => f.authorize(f.envelope, leg, f.observation));
    },
  );
}
for (const kind of ["FRACTION", "WHOLE"]) {
  test(
    "A4 slippage preserves buyer adverse/favorable direction: " + kind,
    async () => {
      const f = await actionFixture({ kind, action: "BUY" });
      const leg = f.compile({ ...(await f.order()), quantity: "1" }).legs[0];
      refused(() =>
        f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "9" })),
      );
      permitted(() =>
        f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: "11" })),
      );
    },
  );
}
test("A4 slippage uses exact BigInt arithmetic above number precision", async () => {
  const price = "9007199254740993";
  const f = await actionFixture({
    action: "CREATE_ORDER",
    intentPatch: {
      minUnitPrice: "1",
      maxUnitPrice: price,
      maxTransactionValue: price,
      maxAggregateExposure: price,
      slippageLimit: "0",
    },
  });
  const leg = f.compile(
    await f.order({ owner: f.user, unitPrice: price, maxAmount: "1" }),
  ).legs[0];
  refused(() =>
    f.authorize(
      f.envelope,
      leg,
      f.observe(leg, { quotedValue: (BigInt(price) + 1n).toString() }),
    ),
  );
  permitted(() =>
    f.authorize(f.envelope, leg, f.observe(leg, { quotedValue: price })),
  );
});
test("A4 slippage does not accept a caller-side direction override", async () => {
  const f = await actionFixture({ action: "CREATE_ORDER" });
  const leg = f.compile(await f.order({ owner: f.user })).legs[0];
  const observation = f.observe(leg, {
    quotedValue: (BigInt(leg.value) + 1n).toString(),
    priceDirection: "BUY",
  });
  refused(() => f.authorize(f.envelope, leg, observation));
});
