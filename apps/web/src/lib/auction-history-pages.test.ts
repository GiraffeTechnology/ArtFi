import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { readAuctionHistoryPage, type AuctionHistoryCursor, type AuctionHistoryReader } from "./auction-history-pages";

// Synthetic RPC records only; no live source, wallet or auction is represented.
const market = ("0x" + "1".repeat(40)) as Address;
const actor = ("0x" + "2".repeat(40)) as Address;
const digest = (value: bigint) => ("0x" + (value + 1n).toString(16).padStart(64, "0")) as Hex;
const header = (number: bigint) => ({ number, hash: digest(number), timestamp: 1000n });
const bid = (number: bigint, index = 0) => ({ address: market, blockNumber: number, blockHash: digest(number), transactionHash: digest(number + 100000n), logIndex: index, removed: false, eventName: "BidPlaced", args: { listingId: 7n, bidder: actor, amount: 21n } });
type Query = { event: { name: string }; args: { listingId: bigint }; fromBlock: bigint; toBlock: bigint };
function fixture(logs: ReturnType<typeof bid>[] = []) {
  let head = 25005n;
  const client = {
    getChainId: vi.fn().mockResolvedValue(560048),
    getBlock: vi.fn(async (query?: { blockNumber?: bigint }) => header(query?.blockNumber ?? head)),
    getLogs: vi.fn(async (query: Query) => logs.filter((log) => log.eventName === query.event.name && log.args.listingId === query.args.listingId && log.blockNumber >= query.fromBlock && log.blockNumber <= query.toBlock)),
  };
  return { client, reader: client as unknown as AuctionHistoryReader, advance: (value: bigint) => { head = value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("pinned auction history pages", () => {
  it("walks disjoint older ranges to block zero and returns to newer ranges on the original anchor", async () => {
    const f = fixture([bid(25000n), bid(10000n), bid(1n)]);
    const first = await readAuctionHistoryPage(f.reader, market, "7", { blockSpan: 10000 });
    expect([first.fromBlock, first.toBlock]).toEqual([15006n, 25005n]);
    f.advance(30000n);
    const second = await readAuctionHistoryPage(f.reader, market, "7", { cursor: first.older });
    const last = await readAuctionHistoryPage(f.reader, market, "7", { cursor: second.older });
    expect([second.fromBlock, second.toBlock, last.fromBlock, last.toBlock]).toEqual([5006n, 15005n, 0n, 5005n]);
    expect(last.older).toBeNull();
    expect(last.anchorBlock).toBe(first.anchorBlock);
    expect(last.anchorHash).toBe(first.anchorHash);
    const newer = await readAuctionHistoryPage(f.reader, market, "7", { cursor: last.newer });
    expect([newer.fromBlock, newer.toBlock]).toEqual([second.fromBlock, second.toBlock]);
    const fresh = await readAuctionHistoryPage(f.reader, market, "7", { blockSpan: 10000 });
    expect(fresh.anchorBlock).toBe(30000n);
    expect(first.newer).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.older)).toBe(true);
    expect(Object.isFrozen(first.entries[0])).toBe(true);
  });

  it("queries each fixed event by its indexed listing ID and preserves complete bid provenance", async () => {
    const f = fixture([bid(25000n), bid(25000n)]);
    const page = await readAuctionHistoryPage(f.reader, market, "7");
    expect(f.client.getLogs).toHaveBeenCalledTimes(5);
    for (const [query] of f.client.getLogs.mock.calls) expect(query).toMatchObject({ address: market, args: { listingId: 7n }, strict: true });
    expect(page.duplicateCount).toBe(1);
    expect(page.entries).toEqual([expect.objectContaining({ event: "BidPlaced", actor, amount: "21", blockHash: digest(25000n), blockNumber: 25000n, transactionHash: digest(125000n) })]);
    expect(f.client.getBlock).toHaveBeenCalledWith({ blockNumber: 25000n });
  });

  it("rejects foreign, aliased, extra, getter and noncongruent cursor fields before RPC", async () => {
    const f = fixture();
    const first = await readAuctionHistoryPage(f.reader, market, "7");
    const good = first.older as AuctionHistoryCursor;
    const getter = vi.fn(() => good.anchorHash);
    const accessor = { ...good };
    Object.defineProperty(accessor, "anchorHash", { enumerable: true, get: getter });
    for (const cursor of [
      { ...good, market: actor }, { ...good, listingId: "8" }, { ...good, chainId: 1 },
      { ...good, blockSpan: 0 }, { ...good, blockSpan: "1000" }, { ...good, version: "future" },
      { ...good, extra: true }, { ...good, nextToBlock: "1" }, { ...good, nextToBlock: "999999999" },
      { ...good, anchorBlock: "01" }, { ...good, anchorHash: "0x" + "0".repeat(64) },
      Object.assign(Object.create(null), good), accessor,
    ]) {
      f.client.getChainId.mockClear();
      await expect(readAuctionHistoryPage(f.reader, market, "7", { cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
      expect(f.client.getChainId).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
    await expect(readAuctionHistoryPage(f.reader, market, "7", { cursor: good, blockSpan: 10 })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("snapshots mutable cursor data before its first asynchronous source read", async () => {
    const f = fixture();
    const first = await readAuctionHistoryPage(f.reader, market, "7");
    const cursor = { ...first.older! };
    const expected = BigInt(cursor.nextToBlock);
    const pending = readAuctionHistoryPage(f.reader, market, "7", { cursor });
    cursor.nextToBlock = "0";
    expect((await pending).toBlock).toBe(expected);
  });

  it("refuses an orphaned cursor anchor before querying more logs", async () => {
    const f = fixture();
    const first = await readAuctionHistoryPage(f.reader, market, "7");
    f.client.getLogs.mockClear();
    f.client.getBlock.mockResolvedValue({ ...header(first.anchorBlock), hash: digest(999999n) });
    await expect(readAuctionHistoryPage(f.reader, market, "7", { cursor: first.older })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(f.client.getLogs).not.toHaveBeenCalled();
  });

  it("rejects a stale event-block hash, wrong final chain and changed final anchor", async () => {
    const f = fixture([bid(25000n)]);
    f.client.getBlock.mockImplementation(async (query) => query?.blockNumber === 25000n ? { ...header(25000n), hash: digest(999999n) } : header(query?.blockNumber ?? 25005n));
    await expect(readAuctionHistoryPage(f.reader, market, "7")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const chain = fixture();
    chain.client.getChainId.mockResolvedValueOnce(560048).mockResolvedValue(1);
    await expect(readAuctionHistoryPage(chain.reader, market, "7")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const anchor = fixture();
    anchor.client.getBlock.mockResolvedValueOnce(header(25005n)).mockResolvedValue({ ...header(25005n), hash: digest(999999n) });
    await expect(readAuctionHistoryPage(anchor.reader, market, "7")).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("does not substitute empty history for dense ranges or too many observed blocks", async () => {
    const dense = fixture();
    dense.client.getLogs.mockImplementation(async (query) => query.event.name === "BidPlaced" ? Array.from({ length: 1000 }, (_, i) => bid(25000n, i)) : []);
    await expect(readAuctionHistoryPage(dense.reader, market, "7")).rejects.toMatchObject({ code: "DENSE_RANGE" });
    const blocks = fixture(Array.from({ length: 65 }, (_, i) => bid(25000n - BigInt(i))));
    await expect(readAuctionHistoryPage(blocks.reader, market, "7")).rejects.toMatchObject({ code: "DENSE_RANGE" });
  });

  it("rejects ignored listing filters, conflicting positions and removed logs", async () => {
    for (const values of [
      [{ ...bid(25000n), args: { ...bid(25000n).args, listingId: 8n } }],
      [bid(25000n), { ...bid(25000n), transactionHash: digest(333333n) }],
      [{ ...bid(25000n), removed: true }],
    ]) {
      const f = fixture();
      f.client.getLogs.mockImplementation(async (query) => query.event.name === "BidPlaced" ? values : []);
      await expect(readAuctionHistoryPage(f.reader, market, "7")).rejects.toMatchObject({ code: "MALFORMED" });
    }
  });

  it("drains each fixed event batch and fences cancellation without a partial page", async () => {
    const f = fixture(), started = deferred<void>(), gate = deferred<ReturnType<typeof bid>[]>();
    f.client.getLogs.mockImplementation(async () => { started.resolve(); return gate.promise; });
    const controller = new AbortController();
    const pending = readAuctionHistoryPage(f.reader, market, "7", { signal: controller.signal });
    await started.promise;
    controller.abort();
    gate.resolve([]);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(f.client.getLogs).toHaveBeenCalledTimes(5);
    expect(f.client.getBlock).toHaveBeenCalledTimes(1);
  });

  it("redacts upstream diagnostics and rejects invalid queries without RPC", async () => {
    const f = fixture();
    for (const blockSpan of [0, -1, 10001, Number.NaN, 1.5]) {
      await expect(readAuctionHistoryPage(f.reader, market, "7", { blockSpan })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
    expect(f.client.getChainId).not.toHaveBeenCalled();
    f.client.getChainId.mockRejectedValue(new Error("synthetic-private-rpc-diagnostic"));
    await expect(readAuctionHistoryPage(f.reader, market, "7")).rejects.toMatchObject({ message: "UNAVAILABLE", code: "UNAVAILABLE" });
  });
});
