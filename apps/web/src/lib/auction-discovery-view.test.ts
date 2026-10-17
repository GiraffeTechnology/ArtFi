import { describe, expect, it } from "vitest";
import { orderAuctionDiscoveryRows } from "./auction-discovery-view";
import type { DiscoveredAuction } from "./auction-discovery-pages";

const address = ("0x" + "1".repeat(40)) as `0x${string}`;
const hash = (n: number) =>
  ("0x" + (n + 1).toString(16).padStart(64, "0")) as `0x${string}`;
function row(
  id: number,
  blockNumber: bigint,
  logIndex: number,
  endsAt = 100,
): DiscoveredAuction {
  return Object.freeze({
    listingId: String(id),
    seller: address,
    asset: address,
    payment: address,
    requestId: hash(id),
    blockNumber,
    blockHash: hash(id + 100),
    transactionHash: hash(id + 200),
    logIndex,
    state: "active",
    amountRemaining: "1",
    openingBid: "900719925474099312345",
    startsAt: 10,
    endsAt,
  });
}
describe("auction discovery page ordering", () => {
  it("orders bigint source positions without rounding large adjacent block numbers", () => {
    const a = row(1, 9007199254740992n, 9),
      b = row(2, 9007199254740993n, 0),
      c = row(3, 9007199254740993n, 1);
    expect(orderAuctionDiscoveryRows([b, a, c], "newest")).toEqual([c, b, a]);
    expect(orderAuctionDiscoveryRows([b, a, c], "oldest")).toEqual([a, b, c]);
  });
  it("sorts end times with deterministic source-order ties rather than claiming live eligibility", () => {
    const a = row(1, 10n, 1, 200),
      b = row(2, 11n, 1, 100),
      c = row(3, 12n, 1, 100);
    expect(orderAuctionDiscoveryRows([a, b, c], "ends-first")).toEqual([
      c,
      b,
      a,
    ]);
    expect(orderAuctionDiscoveryRows([a, b, c], "ends-first")[0].state).toBe(
      "active",
    );
  });
  it("preserves frozen page rows, exact base-unit values and caller order", () => {
    const a = row(1, 10n, 1),
      b = row(2, 11n, 1),
      source = Object.freeze([a, b]);
    const sorted = orderAuctionDiscoveryRows(source, "newest");
    expect(source).toEqual([a, b]);
    expect(sorted).not.toBe(source);
    expect(sorted[0]).toBe(b);
    expect(Object.isFrozen(sorted)).toBe(true);
    expect(sorted[0].openingBid).toBe("900719925474099312345");
  });
  it("preserves empty/single pages and refuses an unsupported runtime order", () => {
    const a = row(1, 10n, 1);
    expect(orderAuctionDiscoveryRows([], "newest")).toEqual([]);
    expect(orderAuctionDiscoveryRows([a], "oldest")).toEqual([a]);
    expect(() => orderAuctionDiscoveryRows([a], "future" as "newest")).toThrow(
      "Unsupported auction display order",
    );
  });
});
