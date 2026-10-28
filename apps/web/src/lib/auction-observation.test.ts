import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  auctionCountdown,
  decodeAuctionTimeline,
  readAuctionObservation,
} from "./auction-observation";
import type { AuctionReader, AuctionSnapshot } from "./auction";

const market = ("0x" + "1".repeat(40)) as Address,
  actor = ("0x" + "2".repeat(40)) as Address;
const tx = ("0x" + "3".repeat(64)) as Hex,
  blockHash = ("0x" + "4".repeat(64)) as Hex;
const head = { number: 100n, hash: blockHash, timestamp: 200n };
const bid = {
  address: market,
  transactionHash: tx,
  blockHash,
  blockNumber: 100n,
  logIndex: 1,
  removed: false,
  eventName: "BidPlaced",
  args: { listingId: 7n, bidder: actor, amount: 21n },
};
function reader(logs: unknown = [bid]) {
  return {
    getChainId: vi.fn().mockResolvedValue(560048),
    getBlock: vi.fn().mockResolvedValue(head),
    getLogs: vi.fn().mockResolvedValue(logs),
    readContract: vi
      .fn()
      .mockImplementation(
        async ({ functionName }: { functionName: string }) => {
          if (functionName === "listings")
            return [actor, actor, actor, 10n, 1n, 100n, 500n, 1, 1, actor, 5n];
          if (functionName === "auctionTerms") return [2n, 1n, 500n, 60n, 60n];
          if (functionName === "paused") return false;
          throw new Error("unexpected contract query");
        },
      ),
  };
}
describe("auction observation attribution", () => {
  it("retains the complete source identity, values and canonical range", async () => {
    const client = reader();
    const result = await readAuctionObservation(
      client as unknown as AuctionReader,
      market,
      "7",
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        sourceKey: `560048:${tx}:1`,
        amount: "21",
        actor,
        event: "BidPlaced",
        blockHash,
        blockNumber: 100n,
        listingId: "7",
      }),
    ]);
    expect(result.fromBlock).toBe(0n);
    expect(result.toBlock).toBe(100n);
    expect(client.getLogs.mock.calls[0][0]).toMatchObject({
      fromBlock: 0n,
      toBlock: 100n,
      address: market,
      strict: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
  });
  it("decodes creation, extension, settlement and cancellation without inventing amounts", () => {
    const logs = [
      {
        ...bid,
        eventName: "ListingCreated",
        logIndex: 0,
        args: { listingId: 7n, requestId: tx, seller: actor },
      },
      {
        ...bid,
        eventName: "AuctionExtended",
        logIndex: 2,
        args: { listingId: 7n, previousEnd: 500n, extendedEnd: 560n },
      },
      {
        ...bid,
        eventName: "ListingSettled",
        logIndex: 3,
        args: { listingId: 7n, buyer: actor, payment: 99n },
      },
      {
        ...bid,
        eventName: "ListingCancelled",
        logIndex: 4,
        args: { listingId: 7n },
      },
    ];
    const result = decodeAuctionTimeline(logs, market, "7", 0n, 100n).entries;
    expect(result.map((e) => e.event)).toEqual([
      "ListingCancelled",
      "ListingSettled",
      "AuctionExtended",
      "ListingCreated",
    ]);
    expect(result[0].amount).toBeUndefined();
    expect(result[1].amount).toBe("99");
    expect(result[2]).toMatchObject({ previousEnd: "500", extendedEnd: "560" });
    expect(result[3].requestId).toBe(tx);
  });
  it("deduplicates identical deliveries but rejects conflicting same-event identities", () => {
    expect(
      decodeAuctionTimeline([bid, bid], market, "7", 0n, 100n),
    ).toMatchObject({ duplicateCount: 1, entries: [expect.any(Object)] });
    expect(() =>
      decodeAuctionTimeline(
        [bid, { ...bid, args: { ...bid.args, amount: 22n } }],
        market,
        "7",
        0n,
        100n,
      ),
    ).toThrow("Conflicting");
    const created = {
      ...bid,
      eventName: "ListingCreated",
      args: { listingId: 7n, requestId: tx, seller: actor },
    };
    expect(() =>
      decodeAuctionTimeline(
        [
          created,
          {
            ...created,
            args: { ...created.args, requestId: "0x" + "5".repeat(64) },
          },
        ],
        market,
        "7",
        0n,
        100n,
      ),
    ).toThrow("Conflicting");
  });
  it.each([
    ["non-array", { logs: [bid] }],
    ["removed", [{ ...bid, removed: true }]],
    ["wrong contract", [{ ...bid, address: actor }]],
    ["out of range", [{ ...bid, blockNumber: 101n }]],
    ["missing source hash", [{ ...bid, blockHash: null }]],
    ["wrong integer type", [{ ...bid, args: { ...bid.args, amount: "21" } }]],
    [
      "extra argument",
      [{ ...bid, args: { ...bid.args, unrelated: "private" } }],
    ],
    ["unknown event", [{ ...bid, eventName: "CreditWithdrawn" }]],
    ["log index overflow", [{ ...bid, logIndex: 4294967296 }]],
    [
      "no forward extension",
      [
        {
          ...bid,
          eventName: "AuctionExtended",
          args: { listingId: 7n, previousEnd: 500n, extendedEnd: 500n },
        },
      ],
    ],
  ])("refuses %s as an unavailable observation", (_name, value) => {
    expect(() => decodeAuctionTimeline(value, market, "7", 0n, 100n)).toThrow();
  });
  it("distinguishes a validated empty range from a malformed response", async () => {
    expect(
      (
        await readAuctionObservation(
          reader([]) as unknown as AuctionReader,
          market,
          "7",
        )
      ).entries,
    ).toEqual([]);
    await expect(
      readAuctionObservation(
        reader(null) as unknown as AuctionReader,
        market,
        "7",
      ),
    ).rejects.toThrow();
  });
  it("does not publish a reorganized head or changed reader chain", async () => {
    const reorganized = reader();
    reorganized.getBlock
      .mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ ...head, hash: "0x" + "5".repeat(64) });
    await expect(
      readAuctionObservation(
        reorganized as unknown as AuctionReader,
        market,
        "7",
      ),
    ).rejects.toThrow("reorganized");
    const switched = reader();
    switched.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
    await expect(
      readAuctionObservation(switched as unknown as AuctionReader, market, "7"),
    ).rejects.toThrow("changed chains");
  });
  it("keeps the display countdown separate from eligibility and rejects stale clocks", () => {
    const snapshot = {
      state: 1,
      timestamp: 200,
      startsAt: 100,
      endsAt: 500,
    } as AuctionSnapshot;
    expect(auctionCountdown(snapshot, 1000, 6000)).toEqual({
      phase: "ends",
      seconds: 295,
    });
    expect(auctionCountdown(snapshot, 1000, 32000).phase).toBe("unavailable");
    expect(auctionCountdown(snapshot, 1000, 999).phase).toBe("unavailable");
    expect(auctionCountdown({ ...snapshot, state: 2 }, 1000, 6000).phase).toBe(
      "closed",
    );
    expect(
      auctionCountdown({ ...snapshot, startsAt: 300 }, 1000, 6000),
    ).toEqual({ phase: "starts", seconds: 95 });
  });
});
