// Isolated signed orders and synthetic observations only; no network signer or
// live marketplace execution is used by these scheduling regressions.
import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFixture,
  syntheticEvidence,
  ethers,
} from "./action-fixtures.mjs";
import { createActionPolicy } from "../../../scripts/agent/action-policy.mjs";
import {
  FRACTION_SALE_TYPES,
  WHOLE_SALE_TYPES,
  ACTION_BITS,
} from "../../../scripts/agent/stage1-action-plans.mjs";
import { INTENT_TYPES } from "../../../scripts/agent/bounded-intent.mjs";
import { verifyActionEvidence } from "../../../scripts/agent/action-evidence.mjs";

async function fixture(kind) {
  const f = await actionFixture({ kind, action: "CREATE_ORDER" });
  const now = BigInt(f.envelope.intent.validFrom) + 60n;
  async function order({
    owner = f.user,
    salt = "1",
    start = now + 60n,
    end = now + 120n,
  } = {}) {
    const value = await f.order({ owner, salt });
    value.intent.startsAt = String(start);
    value.intent.endsAt = String(end);
    value.signature = await owner.signTypedData(
      {
        name:
          kind === "WHOLE"
            ? "ArtFi Whole Artwork Market"
            : "ArtFi Fractions Market",
        version: "1",
        chainId: 560048,
        verifyingContract: f.market,
      },
      kind === "WHOLE" ? WHOLE_SALE_TYPES : FRACTION_SALE_TYPES,
      value.intent,
    );
    return value;
  }
  function authorize(
    leg,
    {
      at = now,
      patch = {},
      priorLegs = [],
      suspended = false,
      envelope = f.envelope,
    } = {},
  ) {
    return createActionPolicy({
      ethers,
      policy: f.policy,
      clock: () => Number(at) * 1000,
    })(
      envelope,
      leg,
      f.observe(leg, { observedAt: Number(at) * 1000, ...patch }),
      { priorLegs, suspended },
    );
  }
  return { f, now, order, authorize };
}

for (const kind of ["FRACTION", "WHOLE"]) {
  test(`${kind} may publish a signed future order without claiming a fill`, async () => {
    const { f, order, authorize } = await fixture(kind);
    const signed = await order();
    const plan = f.compile(signed),
      leg = plan.legs[0];
    assert.equal(leg.dispatch.kind, "SIGNED_ORDER_PUBLICATION");
    assert.deepEqual(leg.dispatch.args.intent, signed.intent);
    assert.equal(authorize(leg).state, "AUTHORIZED_NOT_EXECUTED");
    const evidence = verifyActionEvidence(
      leg,
      syntheticEvidence(leg, plan.operationId),
    );
    assert.equal(evidence.verified, true);
    assert.equal(evidence.kind, "ORDER_PUBLICATION");
    assert.equal(evidence.transactionHash, undefined);
    const changed = structuredClone(signed);
    changed.intent.startsAt = String(BigInt(changed.intent.startsAt) + 1n);
    assert.throws(() => f.compile(changed), /NATIVE_ORDER_BINDING_REFUSED/);
  });

  test(`${kind} future fills still require the signed start and reject the end boundary`, async () => {
    const { f, now, order, authorize } = await fixture(kind);
    const signed = await order({ owner: f.seller });
    const leg = f.compile(
      { ...signed, quantity: "1" },
      { action: kind === "WHOLE" ? "BUY" : "PARTIAL_FILL" },
    ).legs[0];
    assert.throws(() => authorize(leg), /ORDER_NOT_CURRENT/);
    assert.throws(() => authorize(leg, { at: now + 59n }), /ORDER_NOT_CURRENT/);
    assert.equal(
      authorize(leg, { at: now + 60n }).state,
      "AUTHORIZED_NOT_EXECUTED",
    );
    assert.throws(
      () => authorize(leg, { at: now + 120n }),
      /ORDER_NOT_CURRENT/,
    );
  });

  test(`${kind} future replacements still require confirmed retirement`, async () => {
    const { f, now, order, authorize } = await fixture(kind);
    const original = await order({ start: now - 60n, end: now + 30n });
    const replacement = await order({ salt: "2" });
    const plan = f.compile(
      { original, replacement },
      { action: "AMEND_ORDER" },
    );
    const [retire, replace] = plan.legs;
    const proof = verifyActionEvidence(
      retire,
      syntheticEvidence(retire, plan.operationId),
    );
    assert.equal(proof.verified, true);
    const priorLegs = [{ name: "RETIRE", state: "COMPLETED", proof }];
    assert.throws(() => authorize(replace), /PRIOR_ACTION_UNCONFIRMED/);
    assert.throws(
      () =>
        authorize(replace, {
          priorLegs: [{ name: "RETIRE", state: "UNKNOWN", proof }],
        }),
      /PRIOR_ACTION_UNCONFIRMED/,
    );
    assert.throws(
      () =>
        authorize(replace, {
          priorLegs: [
            {
              name: "RETIRE",
              state: "COMPLETED",
              proof: { ...proof, verified: false },
            },
          ],
        }),
      /PRIOR_ACTION_UNCONFIRMED/,
    );
    assert.throws(
      () =>
        authorize(replace, {
          priorLegs,
          patch: { originalOrderRetired: false },
        }),
      /PRIOR_ACTION_UNCONFIRMED/,
    );
    assert.equal(
      authorize(replace, { priorLegs }).state,
      "AUTHORIZED_NOT_EXECUTED",
    );
    assert.throws(
      () => authorize(replace, { priorLegs, at: now + 120n }),
      /ORDER_NOT_CURRENT/,
    );
  });

  test(`${kind} publication expiry and signed authority validity remain independent`, async () => {
    const { f, now, order, authorize } = await fixture(kind);
    for (const end of [now - 1n, now]) {
      const expired = f.compile(await order({ start: now - 60n, end })).legs[0];
      assert.throws(() => authorize(expired), /ORDER_NOT_CURRENT/);
    }
    const future = f.compile(await order()).legs[0];
    for (const patch of [
      { validFrom: String(now + 1n), validUntil: String(now + 3600n) },
      { validFrom: String(now - 60n), validUntil: String(now) },
    ]) {
      const intent = { ...f.envelope.intent, ...patch };
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
        () => authorize(future, { envelope }),
        /INTENT_NOT_CURRENT/,
      );
    }
  });

  test(`${kind} scheduling does not bypass policy authority budget or suspension checks`, async () => {
    const { f, now, order, authorize } = await fixture(kind);
    const leg = f.compile(await order()).legs[0];
    for (const patch of [
      { revoked: true },
      { nonceAvailable: false },
      { contractPaused: true },
      { groundingCurrent: false },
      { aggregateExposure: "10000" },
      { openOrders: "3" },
      { quotedValue: String(BigInt(leg.value) + 1n) },
      { observedAt: Number(now) * 1000 - 10001 },
    ])
      assert.throws(() => authorize(leg, { patch }));
    assert.throws(
      () => authorize(leg, { suspended: true }),
      /NEW_ACTIVITY_SUSPENDED/,
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
    assert.throws(() => authorize(leg, { envelope }), /ACTION_SCOPE_REFUSED/);
  });
}
