import { describe, expect, it } from "vitest";
import {
  decodeNativeOrder,
  nativeOrderAuthorization,
  nativeOrderFromAuthorization,
} from "./native-order";

const seller = "0x1000000000000000000000000000000000000020";
const market = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const payment = "0x1000000000000000000000000000000000000003";
const common = {
  seller,
  paymentToken: payment,
  buyer: "0x0000000000000000000000000000000000000000",
  salt: "1",
  startsAt: 1000,
  endsAt: 2000,
  epoch: "0",
};
function fixture(kind: "whole" | "fraction" = "whole") {
  return nativeOrderFromAuthorization(
    kind,
    JSON.stringify({
      intent: {
        ...common,
        ...(kind === "whole"
          ? { collection: asset, tokenId: "1", price: "2" }
          : { assetToken: asset, maxAmount: "10", unitPrice: "2" }),
      },
      signature: "0x",
    }),
    market,
  );
}

describe("native signed-order wire format", () => {
  it.each(["whole", "fraction"] as const)(
    "round trips existing %s authorizations without changing the hash",
    (kind) => {
      const order = fixture(kind);
      expect(
        decodeNativeOrder(JSON.parse(JSON.stringify(order))).order,
      ).toEqual(order);
      expect(
        nativeOrderFromAuthorization(
          kind,
          nativeOrderAuthorization(order),
          market,
        ),
      ).toEqual(order);
    },
  );
  it.each([
    "0x1",
    "01",
    "-1",
    "1.0",
    "1e2",
    "",
    (1n << 256n).toString(),
    1,
    null,
  ])("refuses coercible or overflowing uint256 value %s", (value) => {
    const order = fixture();
    expect(() =>
      decodeNativeOrder({
        ...order,
        intent: { ...order.intent, tokenId: value },
      }),
    ).toThrow(/uint256/);
  });
  it.each([NaN, 1.1, -1, 2 ** 48, "1000"])(
    "refuses invalid time %s",
    (startsAt) => {
      const order = fixture();
      expect(() =>
        decodeNativeOrder({ ...order, intent: { ...order.intent, startsAt } }),
      ).toThrow(/uint48/);
    },
  );
  it("rejects altered terms, chain, market, kind and caller status assertions", () => {
    const order = fixture();
    expect(() =>
      decodeNativeOrder({ ...order, intent: { ...order.intent, price: "3" } }),
    ).toThrow(/hash/);
    expect(() => decodeNativeOrder({ ...order, chainId: 1 })).toThrow(/chain/);
    expect(() => decodeNativeOrder({ ...order, marketAddress: asset })).toThrow(
      /hash/,
    );
    expect(() => decodeNativeOrder({ ...order, kind: "fraction" })).toThrow(
      /fields/,
    );
    expect(() => decodeNativeOrder({ ...order, verified: true })).toThrow(
      /unsupported/,
    );
  });
  it("keeps empty EIP-1271 signatures but rejects odd hex, excess fields and oversized signatures", () => {
    const order = fixture();
    expect(decodeNativeOrder(order).order.signature).toBe("0x");
    expect(() => decodeNativeOrder({ ...order, signature: "0x1" })).toThrow(
      /signature/,
    );
    expect(() =>
      decodeNativeOrder({ ...order, signature: `0x${"00".repeat(8193)}` }),
    ).toThrow(/signature/);
    expect(() =>
      decodeNativeOrder({
        ...order,
        intent: { ...order.intent, arbitrary: true },
      }),
    ).toThrow(/fields/);
  });
});
