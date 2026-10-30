import { describe, expect, it } from "vitest";
import { assertSameNftReview } from "./client";
import type { NftPlan } from "./model";

const account = "0x1111111111111111111111111111111111111111";
const seaport = "0x0000000000000068F116a894984e2DB1123eB395";
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
      account,
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
      charity: false,
    },
    expiresAt: Date.now() + 60_000,
    kind: "transaction",
    summary: "TEST_ONLY reviewed purchase",
    fees: [],
    transaction: { to: seaport, data: "0x12345678", value: "100" },
  };
}
function reject(
  change: (
    value: Record<string, unknown> & {
      transaction: { to: unknown; data: unknown; value: unknown };
    },
  ) => void,
) {
  const value = plan();
  change(value as unknown as Parameters<typeof change>[0]);
  // The native caller receives JSON. Two identical malformed responses are still invalid.
  expect(() =>
    assertSameNftReview(value, structuredClone(value), account, 1),
  ).toThrow();
}
describe("NFT review envelope", () => {
  it("regression envelope: rejects an unsupported operation kind in both reviews", () =>
    reject((p) => {
      p.kind = "other";
    }));
  it("regression envelope: rejects a numeric-string review expiry", () =>
    reject((p) => {
      p.expiresAt = String(Date.now() + 60_000);
    }));
  it("regression envelope: rejects odd-byte transaction calldata", () =>
    reject((p) => {
      p.transaction.data = "0x123456789";
    }));
  it.each([
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid expiry %s", (expiry) =>
    reject((p) => {
      p.expiresAt = expiry;
    }),
  );
  it.each([
    undefined,
    null,
    "",
    "0x1234",
    "0x0000000000000000000000000000000000000000",
  ])("rejects invalid approval target %s", (target) =>
    reject((p) => {
      p.kind = "approval";
      p.transaction.to = target;
      p.transaction.value = "0";
    }),
  );
  it.each([100, "01", "-1", "1.0", "0x64", (1n << 256n).toString()])(
    "rejects invalid transaction value %s",
    (value) =>
      reject((p) => {
        p.transaction.value = value;
      }),
  );
  it("rejects a transaction carrying an unrelated signing payload", () =>
    reject((p) => {
      p.typedData = {};
    }));
  it("rejects a signing request carrying a transaction", () =>
    reject((p) => {
      p.kind = "signature";
      p.typedData = {
        domain: {
          name: "Seaport",
          version: "1.6",
          chainId: 1,
          verifyingContract: seaport,
        },
        primaryType: "OrderComponents",
        types: {},
        message: { offerer: account },
      };
    }));
  it("rejects the wrong typed-data primary type", () =>
    reject((p) => {
      Reflect.deleteProperty(p, "transaction");
      p.kind = "signature";
      p.typedData = {
        domain: {
          name: "Seaport",
          version: "1.6",
          chainId: 1,
          verifyingContract: seaport,
        },
        primaryType: "Other",
        types: {},
        message: { offerer: account },
      };
    }));
  it("keeps canonical zero-value approvals available", () => {
    const p = plan();
    p.kind = "approval";
    p.transaction!.to = p.scope.contract;
    p.transaction!.value = "0";
    expect(() =>
      assertSameNftReview(p, structuredClone(p), account, 1),
    ).not.toThrow();
  });
  it("keeps the largest uint256 transaction amount available", () => {
    const p = plan();
    p.transaction!.value = ((1n << 256n) - 1n).toString();
    expect(() =>
      assertSameNftReview(p, structuredClone(p), account, 1),
    ).not.toThrow();
  });
});
