import { describe, expect, it } from "vitest";
import {
  createReceiptLedger, observeFundedTrade, observeRegistrationRequest,
  observeRegistration, observeSellerPayment, observeRegistrationRejection,
  nextSellerPayment, eligibleSellerPayments, receiptRecoveryPlan, observeReceiptRollback,
  observeBuyerRefund, receiptRedemptionIdentityMatches,
  type ReceiptLedger,
} from "./whole-receipt-ledger";

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;
const D = `0x${"d".repeat(40)}`;
const token = `0x${"1".repeat(40)}`;
const binding = {
  assetId: "test-only-receipt", chainId: 560048, collection: token, tokenId: "1",
  intermediaryId: "artfi", registrarId: "external-registrar", oracleId: "trusted-oracle",
};
const proof = (sourceId: string, reference: string) => ({
  assetId: binding.assetId, sourceId, reference,
});
function trade(state: ReceiptLedger, id: string, seller: string, buyer: string) {
  return observeFundedTrade(state, {
    id, seller, buyer, paymentToken: token, amount: 100n,
    escrowReference: `escrow:${id}`, ownerTransferReference: `owner:${id}`,
  });
}
function register(state: ReceiptLedger, id: string, buyer: string) {
  const requested = observeRegistrationRequest(state, id, proof("artfi", `request:${id}`));
  return observeRegistration(requested, id, buyer, `request:${id}`,
    proof(state.binding.oracleId, `registered:${id}`));
}
function chain() {
  return trade(trade(trade(createReceiptLedger(binding, A), "AB", A, B),
    "BC", B, C), "CD", C, D);
}
function reject(state: ReceiptLedger, id: string) {
  return observeRegistrationRejection(
    observeRegistrationRequest(state, id, proof("artfi", `request:${id}`)),
    id, `request:${id}`, proof(state.binding.oracleId, `rejected:${id}`),
  );
}

describe("whole receipt ledger projection", () => {
  it("keeps asynchronous owner and registered holder distinct", () => {
    const state = chain();
    expect(state.owner).toBe(D);
    expect(state.registeredHolder).toBe(A);
    expect(nextSellerPayment(state)).toBeUndefined();
    expect(receiptRedemptionIdentityMatches(state)).toBe(false);
  });

  it("releases each registered trade without waiting for the end of the chain", () => {
    let state = register(chain(), "AB", B);
    expect(state.owner).toBe(D);
    expect(nextSellerPayment(state)?.id).toBe("AB");
    state = observeSellerPayment(state, "AB", "payment:AB");
    expect(state.settledPrefix).toBe(1);
    expect(state.registeredPrefix).toBe(1);
    expect(nextSellerPayment(state)).toBeUndefined();
    state = register(state, "BC", C);
    state = observeSellerPayment(state, "BC", "payment:BC");
    state = register(state, "CD", D);
    state = observeSellerPayment(state, "CD", "payment:CD");
    expect(state.settledPrefix).toBe(3);
    expect(receiptRedemptionIdentityMatches(state)).toBe(true);
  });

  it("request acceptance does not update the holder or release payment", () => {
    const state = observeRegistrationRequest(chain(), "AB", proof("artfi", "request:AB"));
    expect(state.registeredHolder).toBe(A);
    expect(nextSellerPayment(state)).toBeUndefined();
    expect(() => observeSellerPayment(state, "AB", "payment:AB")).toThrow();
  });

  it("does not gate one registered trade's payment on another trade's payment", () => {
    const registered = register(register(chain(), "AB", B), "BC", C);
    expect(eligibleSellerPayments(registered).map((segment) => segment.id))
      .toEqual(["AB", "BC"]);
    const secondPaid = observeSellerPayment(registered, "BC", "payment:BC");
    expect(secondPaid.settledPrefix).toBe(0);
    expect(secondPaid.segments[1].settlementReference).toBe("payment:BC");
    expect(eligibleSellerPayments(secondPaid).map((segment) => segment.id)).toEqual(["AB"]);
    expect(observeSellerPayment(secondPaid, "AB", "payment:AB").settledPrefix).toBe(2);
  });

  it("reconciles an exact historical confirmation replay without moving D back to C", () => {
    const state = register(register(register(chain(), "AB", B), "BC", C), "CD", D);
    const replayed = observeRegistration(state, "BC", C, "request:BC",
      proof(binding.oracleId, "registered:BC"));
    expect(replayed).toBe(state);
    expect(replayed.registeredHolder).toBe(D);
    expect(replayed.registeredPrefix).toBe(3);
    expect(observeSellerPayment(replayed, "BC", "payment:BC").segments[1].settlementReference)
      .toBe("payment:BC");
  });

  it("requires the trusted Oracle data role even when ArtCCH is the registrar", () => {
    let state = createReceiptLedger({ ...binding, registrarId: "artcch" }, A);
    state = trade(state, "AB", A, B);
    state = observeRegistrationRequest(state, "AB", proof("artfi", "request:AB"));
    expect(() => observeRegistration(state, "AB", B, "request:AB",
      proof("artfi", "fake-confirmation"))).toThrow();
    expect(() => observeRegistration(state, "AB", B, "request:AB",
      proof("artcch", "direct-registry-read"))).toThrow();
    expect(observeRegistration(state, "AB", B, "request:AB",
      proof("trusted-oracle", "confirmation")).registeredHolder).toBe(B);
  });

  it("refuses skipped, stale, wrong-holder and wrong-asset confirmations", () => {
    const state = observeRegistrationRequest(chain(), "AB", proof("artfi", "request:AB"));
    expect(() => register(state, "BC", C)).toThrow();
    expect(() => observeRegistration(state, "AB", C, "request:AB",
      proof(binding.oracleId, "wrong-holder"))).toThrow();
    expect(() => observeRegistration(state, "AB", B, "stale-request",
      proof(binding.oracleId, "stale"))).toThrow();
    expect(() => observeRegistration(state, "AB", B, "request:AB", {
      ...proof(binding.oracleId, "wrong-asset"), assetId: "other",
    })).toThrow();
  });

  it("preserves the paid prefix and refunds only the rejected suffix", () => {
    const paid = observeSellerPayment(register(chain(), "AB", B), "AB", "payment:AB");
    let state = reject(paid, "BC");
    const plan = receiptRecoveryPlan(state);
    expect(plan.kind).toBe("suffix-recovery");
    if (plan.kind !== "suffix-recovery") throw new Error("Expected suffix recovery");
    expect(plan.returnTokenTo).toBe(B);
    expect(plan.segments.map((item) => item.segmentId)).toEqual(["BC", "CD"]);
    expect(plan.segments.map((item) => [item.refundGasPayer, item.rollbackGasPayer]))
      .toEqual([[C, C], [D, D]]);
    expect(() => observeBuyerRefund(state, "AB", "refund:AB")).toThrow();
    expect(() => observeReceiptRollback(state, A, "rollback")).toThrow();
    state = observeReceiptRollback(state, B, "rollback");
    state = observeBuyerRefund(state, "BC", "refund:BC");
    state = observeBuyerRefund(state, "CD", "refund:CD");
    expect(state.owner).toBe(B);
    expect(state.segments[0]).toEqual(paid.segments[0]);
    expect(state.settledPrefix).toBe(1);
  });

  it("does not invent a refund rule for registered but unpaid trades", () => {
    const state = reject(register(chain(), "AB", B), "BC");
    expect(receiptRecoveryPlan(state)).toEqual({ kind: "registered-payment-unresolved" });
    expect(() => observeBuyerRefund(state, "AB", "refund:AB")).toThrow();
    expect(() => observeBuyerRefund(state, "BC", "refund:BC")).toThrow();
    // An actual verified payment remains observable; a rejection cannot erase it.
    expect(receiptRecoveryPlan(observeSellerPayment(state, "AB", "payment:AB")).kind)
      .toBe("suffix-recovery");
  });

  it("recovers the entire chain to the initial holder when its first trade is rejected", () => {
    const plan = receiptRecoveryPlan(reject(chain(), "AB"));
    expect(plan.kind).toBe("suffix-recovery");
    if (plan.kind !== "suffix-recovery") throw new Error("Expected suffix recovery");
    expect(plan.returnTokenTo).toBe(A);
    expect(plan.segments).toHaveLength(3);
  });

  it("keeps each buyer's exact currency and amount in the refund suffix", () => {
    const secondToken = `0x${"2".repeat(40)}`;
    const first = trade(createReceiptLedger(binding, A), "AB", A, B);
    const second = observeFundedTrade(first, {
      id: "BC", seller: B, buyer: C, paymentToken: secondToken,
      amount: 900719925474099312345n,
      escrowReference: "escrow:BC", ownerTransferReference: "owner:BC",
    });
    const plan = receiptRecoveryPlan(reject(second, "AB"));
    if (plan.kind !== "suffix-recovery") throw new Error("Expected suffix recovery");
    expect(plan.segments.map((item) => [item.refundTo, item.paymentToken, item.amount]))
      .toEqual([[B, token, 100n], [C, secondToken, 900719925474099312345n]]);
  });

  it("refuses duplicate trade, payment, refund and rollback observations", () => {
    const initial = createReceiptLedger(binding, A);
    const funded = trade(initial, "AB", A, B);
    expect(() => trade(funded, "AB", B, C)).toThrow();
    let state = observeSellerPayment(register(chain(), "AB", B), "AB", "payment:AB");
    expect(() => observeSellerPayment(state, "AB", "payment:AB")).toThrow();
    state = observeBuyerRefund(reject(state, "BC"), "BC", "refund:BC");
    expect(() => observeBuyerRefund(state, "CD", "refund:BC")).toThrow();
    state = observeReceiptRollback(state, B, "rollback");
    expect(() => observeReceiptRollback(state, B, "rollback")).toThrow();
    expect(() => trade(state, "BE", B, D)).toThrow();
  });

  it("validates amounts and bindings and does not mutate earlier projections", () => {
    const state = createReceiptLedger(binding, A);
    expect(() => createReceiptLedger({ ...binding, tokenId: "-1" }, A)).toThrow();
    expect(() => createReceiptLedger({ ...binding, chainId: NaN }, A)).toThrow();
    expect(() => createReceiptLedger({ ...binding, registrarId: "artfi" }, A)).toThrow();
    expect(() => observeFundedTrade(state, {
      id: "AB", seller: A, buyer: B, paymentToken: token, amount: 0n,
      escrowReference: "escrow:AB", ownerTransferReference: "owner:AB",
    })).toThrow();
    expect(() => observeFundedTrade(state, {
      id: "AB", seller: A, buyer: B, paymentToken: token,
      amount: NaN as unknown as bigint,
      escrowReference: "escrow:AB", ownerTransferReference: "owner:AB",
    })).toThrow();
    expect(() => trade(state, "AB", C, B)).toThrow();
    trade(state, "AB", A, B);
    expect(state.owner).toBe(A);
    expect(state.segments).toEqual([]);
  });
});
