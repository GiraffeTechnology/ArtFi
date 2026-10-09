import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import {
  auctionActions,
  auctionAmount,
  auctionBidPreflight,
  auctionEvents,
  auctionID,
  auctionMinimumBid,
  assertAuctionUnchanged,
  loadAuction,
  type AuctionReader,
  type AuctionSnapshot,
} from "./auction";
const market = "0x1000000000000000000000000000000000000003" as Address;
const seller = "0x1000000000000000000000000000000000000002" as Address;
const buyer = "0x1000000000000000000000000000000000000001" as Address;
const asset = "0x1000000000000000000000000000000000000004" as Address;
const payment = "0x1000000000000000000000000000000000000005" as Address;
const hash = `0x${"1".repeat(64)}` as Hex;
let listing: unknown[],
  terms: unknown[],
  paused: boolean,
  balance: bigint,
  cap: bigint,
  used: bigint,
  allowed: boolean;
const block = { number: 100n, hash, timestamp: 1000n };
let read: ReturnType<typeof vi.fn>,
  getBlock: ReturnType<typeof vi.fn>,
  getChainId: ReturnType<typeof vi.fn>,
  getLogs: ReturnType<typeof vi.fn>,
  client: AuctionReader;
beforeEach(() => {
  listing = [
    seller,
    asset,
    payment,
    10n,
    100n,
    900,
    1100,
    1,
    1,
    zeroAddress,
    0n,
  ];
  terms = [120n, 5n, 1100, 300, 300];
  paused = false;
  balance = 10000n;
  cap = 10000n;
  used = 0n;
  allowed = true;
  read = vi.fn(
    async ({ functionName }: { functionName: string }) =>
      ({
        listings: listing,
        auctionTerms: terms,
        paused,
        balanceOf: balance,
        pilotPaymentCap: cap,
        pilotPaymentUsed: used,
        allowedPaymentToken: allowed,
      })[functionName],
  );
  getBlock = vi.fn(async () => block);
  getChainId = vi.fn(async () => 560048);
  getLogs = vi.fn(async () => []);
  client = {
    readContract: read,
    getBlock,
    getChainId,
    getLogs,
  } as unknown as AuctionReader;
});
describe("bounded auction amounts", () => {
  it("preserves exact large quantities", () =>
    expect(auctionAmount("9007199254740993.123456", 6)).toBe(
      9007199254740993123456n,
    ));
  it.each(["0", "-1", "1e4", "01", "1.001", "1.", " 1", String(1n << 256n)])(
    "rejects invalid or silently-rounded amount %s",
    (value) => expect(() => auctionAmount(value, 2)).toThrow(),
  );
  it.each(["0", "-1", "01", "1.5", String(1n << 256n)])(
    "rejects invalid ID %s",
    (value) => expect(() => auctionID(value)).toThrow(),
  );
});
describe("auction observations and execution", () => {
  it("pins every state read to one confirmed observation", async () => {
    const snapshot = await loadAuction(client, market, "1");
    expect(snapshot).toMatchObject({
      reserve: 120n,
      openingBid: 100n,
      endsAt: 1100,
      blockHash: hash,
    });
    expect(read.mock.calls.every(([input]) => input.blockNumber === 100n)).toBe(
      true,
    );
    expect(auctionMinimumBid(snapshot)).toBe(100n);
  });
  it("uses the current highest bid plus the exact increment", async () => {
    listing[9] = buyer;
    listing[10] = 150n;
    expect(auctionMinimumBid(await loadAuction(client, market, "1"))).toBe(
      155n,
    );
  });
  it("keeps settlement and no-bid seller escape available while paused", async () => {
    paused = true;
    const a = await loadAuction(client, market, "1");
    expect(auctionActions(a, seller)).toEqual({
      bid: false,
      settle: false,
      cancel: true,
    });
    expect(auctionActions({ ...a, timestamp: 1100 }, seller).settle).toBe(true);
    expect(auctionActions({ ...a, highestBidder: buyer }, seller).cancel).toBe(
      false,
    );
    expect(auctionActions(a, buyer).cancel).toBe(false);
  });
  it("requires the auction chain before any state reads", async () => {
    getChainId.mockResolvedValue(1);
    await expect(loadAuction(client, market, "1")).rejects.toThrow("Hoodi");
    expect(read).not.toHaveBeenCalled();
  });
  it("does not display a fixed-price listing as an auction", async () => {
    listing[7] = 0;
    await expect(loadAuction(client, market, "1")).rejects.toThrow(
      "No auction",
    );
  });
  it.each(["endsAt", "highestBid", "reserve", "payment", "paused"] as const)(
    "rejects changed %s",
    async (key) => {
      const a = await loadAuction(client, market, "1");
      const changed = {
        ...a,
        [key]:
          key === "payment"
            ? asset
            : key === "paused"
              ? true
              : key === "endsAt"
                ? 1200
                : 999n,
      } as AuctionSnapshot;
      expect(() => assertAuctionUnchanged(a, changed)).toThrow("changed");
    },
  );
  it("checks payment balance, cumulative pilot cap and a canonical block", async () => {
    const a = await loadAuction(client, market, "1");
    await expect(
      auctionBidPreflight(client, a, buyer, 100n),
    ).resolves.toMatchObject({ id: "1" });
    expect(read.mock.calls.every(([input]) => input.blockNumber === 100n)).toBe(
      true,
    );
  });
  it.each(["balance", "cap", "permission"])(
    "refuses a bid when %s changes",
    async (mode) => {
      const a = await loadAuction(client, market, "1");
      if (mode === "balance") balance = 99n;
      if (mode === "cap") used = 9901n;
      if (mode === "permission") allowed = false;
      await expect(auctionBidPreflight(client, a, buyer, 100n)).rejects.toThrow(
        "prevents",
      );
    },
  );
  it("does not silently chase a changed bid or extension", async () => {
    const a = await loadAuction(client, market, "1");
    terms[2] = 1400;
    await expect(auctionBidPreflight(client, a, buyer, 100n)).rejects.toThrow(
      "changed",
    );
  });
  it("fails closed after an observation reorg", async () => {
    const a = await loadAuction(client, market, "1");
    getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValueOnce({ ...block, hash: `0x${"2".repeat(64)}` });
    await expect(auctionBidPreflight(client, a, buyer, 100n)).rejects.toThrow(
      "reorganized",
    );
  });
  it("requires the exact start/end boundary and bid minimum", async () => {
    const a = await loadAuction(client, market, "1");
    expect(auctionActions({ ...a, timestamp: 899 }).bid).toBe(false);
    expect(auctionActions({ ...a, timestamp: 1100 }).bid).toBe(false);
    await expect(auctionBidPreflight(client, a, buyer, 99n)).rejects.toThrow(
      "minimum",
    );
  });
});
describe("attributed auction history", () => {
  it("filters another auction and removed events and sorts newest first", async () => {
    getLogs.mockResolvedValue([
      { args: { listingId: 1n }, removed: false, blockNumber: 2n, logIndex: 0 },
      { args: { listingId: 2n }, removed: false, blockNumber: 3n, logIndex: 0 },
      { args: { listingId: 1n }, removed: true, blockNumber: 4n, logIndex: 0 },
      { args: { listingId: 1n }, removed: false, blockNumber: 3n, logIndex: 2 },
    ]);
    const result = await auctionEvents(client, market, "1");
    expect(result.logs.map((log) => log.blockNumber)).toEqual([3n, 2n]);
    expect(getLogs.mock.calls[0][0]).toMatchObject({
      address: market,
      fromBlock: 0n,
      toBlock: 100n,
      strict: true,
    });
  });
  it("bounds history queries", async () => {
    getBlock.mockResolvedValue({ ...block, number: 100000n });
    await expect(auctionEvents(client, market, undefined, 0n)).rejects.toThrow(
      "50,000",
    );
    expect(getLogs).not.toHaveBeenCalled();
  });
  it("rejects history on another chain or a reorganized head", async () => {
    getChainId.mockResolvedValue(1);
    await expect(auctionEvents(client, market)).rejects.toThrow("Hoodi");
    getChainId.mockResolvedValue(560048);
    getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValueOnce({ ...block, hash: `0x${"2".repeat(64)}` });
    await expect(auctionEvents(client, market)).rejects.toThrow("reorganized");
  });
});
