import { describe, expect, it } from "vitest";
import { nativeOrderFromAuthorization } from "./native-order";
import {
  planFractionMatches,
  rankFractionCandidates,
  type FractionMatchRequest,
} from "./fraction-matching";

const market = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const payment = "0x1000000000000000000000000000000000000003";
const buyer = "0x1000000000000000000000000000000000000004";
const seller = "0x1000000000000000000000000000000000000005";
const request: FractionMatchRequest = {
  market,
  asset,
  paymentToken: payment,
  buyer,
  amount: 1n,
  maxPayment: 100n,
};
function order(createdAt: string, salt = "1", unitPrice = "2") {
  return {
    ...nativeOrderFromAuthorization(
      "fraction",
      JSON.stringify({
        intent: {
          seller,
          assetToken: asset,
          paymentToken: payment,
          maxAmount: "10",
          unitPrice,
          buyer: "0x0000000000000000000000000000000000000000",
          salt,
          startsAt: 1000,
          endsAt: 2000,
          epoch: "0",
        },
        signature: "0x",
      }),
      market,
    ),
    createdAt,
  };
}
describe("fraction publication calendar admission", () => {
  it.each([
    "2026-02-29T00:00:00.000001Z",
    "2026-02-30T00:00:00Z",
    "2026-04-31T12:30:00Z",
    "2026-01-01T24:00:00Z",
    "2100-02-29T00:00:00Z",
  ])("rejects normalized calendar time %s", (createdAt) => {
    expect(() => rankFractionCandidates([order(createdAt)], request)).toThrow(
      "publication time",
    );
  });
  it.each([
    "2000-02-29T00:00:00Z",
    "2024-02-29T23:59:59.123456789Z",
    "2026-12-31T23:59:59.999999999Z",
    "2027-01-01T00:00:00Z",
  ])("retains canonical publication time %s", (createdAt) => {
    const [result] = rankFractionCandidates([order(createdAt)], request);
    expect(result.order.createdAt).toBe(createdAt);
  });
  it("keeps nanosecond and microsecond ordering across the year boundary", () => {
    const first = order("2026-12-31T23:59:59.999999998Z", "1");
    const second = order("2026-12-31T23:59:59.999999999Z", "2");
    const third = order("2027-01-01T00:00:00.000000001Z", "3");
    const fourth = order("2027-01-01T00:00:00.000001Z", "4");
    const expected = [first, second, third, fourth].map(
      (item) => item.intentHash,
    );
    for (const input of [
      [fourth, third, second, first],
      [second, fourth, first, third],
    ]) {
      expect(
        rankFractionCandidates(input, request).map(
          (item) => item.order.intentHash,
        ),
      ).toEqual(expected);
    }
  });
  it("rejects an invalid lower-priority timestamp before preparing any partial plan", () => {
    const first = order("2026-01-01T00:00:00Z", "1", "1");
    const invalid = order("2026-02-30T00:00:00Z", "2", "2");
    expect(() =>
      planFractionMatches({
        orders: [first, invalid],
        request,
        at: 1500n,
        paymentAvailable: 100n,
        liquidity: new Map(
          [first, invalid].map((item) => [
            item.intentHash,
            {
              filled: 0n,
              epoch: 0n,
              balance: 100n,
              allowance: 100n,
              signatureValid: true,
            },
          ]),
        ),
      }),
    ).toThrow("publication time");
  });
  it.each([
    "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00.1234567890Z",
    "2026-01-01T00:00:60Z",
    "2026-13-01T00:00:00Z",
  ])(
    "retains rejection of unsupported or invalid timestamp syntax %s",
    (createdAt) => {
      expect(() => rankFractionCandidates([order(createdAt)], request)).toThrow(
        "publication time",
      );
    },
  );
  it("does not rewrite a frozen log entry or its authoritative timestamp", () => {
    const entry = Object.freeze(order("2026-01-01T00:00:00.000000001Z"));
    const before = JSON.stringify(entry);
    rankFractionCandidates([entry], request);
    expect(JSON.stringify(entry)).toBe(before);
  });
});
