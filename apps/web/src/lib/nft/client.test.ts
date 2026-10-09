import { describe, expect, it } from "vitest";
import { assertSameNftReview } from "./client";
import type { NftPlan } from "./model";
const wallet = "0x1111111111111111111111111111111111111111";
function plan(): NftPlan {
  return {
    id: "test-plan",
    operationId: "test-operation-1",
    sessionId: "test-session",
    chainId: 1,
    request: {
      action: "buy",
      collection: "isolated",
      tokenId: "7",
      account: wallet,
      quantity: "1",
      priceWei: "100",
      expiresAt: 0,
    },
    scope: {
      slug: "isolated",
      chain: "ethereum",
      contract: "0x2222222222222222222222222222222222222222",
      standard: "erc1155",
      label: "Isolated",
      charity: true,
    },
    expiresAt: Date.now() + 60000,
    kind: "transaction",
    summary: "Reviewed purchase",
    fees: [],
    transaction: {
      to: "0x0000000000000068F116a894984e2DB1123eB395",
      data: "0x12345678",
      value: "100",
    },
  };
}
function reverse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverse);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverse(item)]),
    );
  return value;
}
describe("wallet review continuity", () => {
  it("accepts unchanged terms despite durable JSON key normalization", () => {
    const original = plan();
    expect(() =>
      assertSameNftReview(original, reverse(original) as NftPlan, wallet, 1),
    ).not.toThrow();
  });
  it.each(["amount", "fee", "wallet", "chain", "expiry", "scope"])(
    "rejects changed %s before wallet approval",
    (field) => {
      const displayed = plan(),
        changed = structuredClone(displayed);
      if (field === "amount") changed.transaction!.value = "101";
      if (field === "fee")
        changed.fees = [{ recipient: wallet, amountWei: "1" }];
      if (field === "wallet")
        changed.request.account = "0x3333333333333333333333333333333333333333";
      if (field === "chain") changed.chainId = 8453;
      if (field === "expiry") changed.expiresAt = 0;
      if (field === "scope") changed.scope.charity = false;
      expect(() =>
        assertSameNftReview(displayed, changed, wallet, 1),
      ).toThrow();
    },
  );
  it("rejects a non-Seaport destination even when supplied in both copies", () => {
    const altered = plan();
    altered.transaction!.to = wallet;
    expect(() => assertSameNftReview(altered, altered, wallet, 1)).toThrow(
      "settlement target",
    );
  });
});
