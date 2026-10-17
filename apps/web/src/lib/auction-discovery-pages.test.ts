import { describe, expect, it, vi } from "vitest";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionResult,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { auctionAbi, type AuctionReader } from "./auction";
import { readAuctionDiscoveryPage } from "./auction-discovery-pages";

// Actual locked SDK ABI encoding/decoding with synthetic public-chain records.
const market = ("0x" + "1".repeat(40)) as Address,
  seller = ("0x" + "2".repeat(40)) as Address;
const asset = ("0x" + "3".repeat(40)) as Address,
  payment = ("0x" + "4".repeat(40)) as Address;
const hash = (n: number) =>
  ("0x" + (n + 1).toString(16).padStart(64, "0")) as Hex;
const header = (number: bigint) => ({
  number,
  hash: hash(Number(number)),
  timestamp: 1000n,
});
function creation(id: number, block = 25000n - BigInt(id)) {
  const topics = encodeEventTopics({
    abi: auctionAbi,
    eventName: "ListingCreated",
    args: { requestId: hash(id + 200), listingId: BigInt(id), seller },
  });
  if (topics.some((x) => typeof x !== "string"))
    throw Error("synthetic fixture requires exact topics");
  const event = decodeEventLog({
    abi: auctionAbi,
    topics: topics as [Hex, ...Hex[]],
    data: "0x",
  });
  return {
    ...event,
    address: market,
    blockNumber: block,
    blockHash: header(block).hash,
    transactionHash: hash(id + 10000),
    logIndex: id,
    removed: false,
  };
}
function listing(kind = 1, state = 1, owner: Address = seller) {
  const data = encodeFunctionResult({
    abi: auctionAbi,
    functionName: "listings",
    result: [
      owner,
      asset,
      payment,
      10n,
      2n,
      1000,
      2000,
      kind,
      state,
      zeroAddress,
      0n,
    ],
  });
  return decodeFunctionResult({
    abi: auctionAbi,
    functionName: "listings",
    data,
  });
}
function fixture(count = 2) {
  const all = Array.from({ length: count }, (_, i) => creation(i + 1));
  let head = 25005n;
  const client = {
    getChainId: vi.fn().mockResolvedValue(560048),
    getBlock: vi.fn(async (query?: { blockNumber?: bigint }) =>
      header(query?.blockNumber ?? head),
    ),
    getLogs: vi.fn(
      async (query: {
        fromBlock: bigint;
        toBlock: bigint;
        args?: { seller?: Address };
      }) =>
        all.filter(
          (e) =>
            e.blockNumber >= query.fromBlock &&
            e.blockNumber <= query.toBlock &&
            (!query.args?.seller || query.args.seller.toLowerCase() === seller),
        ),
    ),
    readContract: vi.fn(
      async (_query: {
        functionName: string;
        args: readonly bigint[];
        blockNumber: bigint;
      }) => listing(),
    ),
  };
  return {
    client,
    reader: client as unknown as AuctionReader,
    all,
    advance: (n: bigint) => {
      head = n;
    },
  };
}
describe("anchored public auction discovery", () => {
  it("uses real SDK-sized scalars and verifies listing type and seller at the original anchor", async () => {
    const f = fixture();
    const page = await readAuctionDiscoveryPage(f.reader, market);
    expect(page.listings).toHaveLength(2);
    expect(page.checkedCandidates).toBe(2);
    expect(page.listings[0]).toMatchObject({
      listingId: "1",
      seller,
      state: "active",
      startsAt: 1000,
      endsAt: 2000,
      openingBid: "2",
      amountRemaining: "10",
    });
    expect(typeof listing()[5]).toBe("number");
    expect(typeof listing()[3]).toBe("bigint");
    for (const [query] of f.client.readContract.mock.calls)
      expect(query).toMatchObject({
        functionName: "listings",
        blockNumber: 25005n,
      });
    expect(Object.isFrozen(page.listings[0])).toBe(true);
  });
  it("checks only one candidate slice and walks records within the same anchored source window", async () => {
    const f = fixture(37);
    const a = await readAuctionDiscoveryPage(f.reader, market, {
      pageSize: 10,
    });
    expect(f.client.readContract).toHaveBeenCalledTimes(10);
    f.advance(30000n);
    const b = await readAuctionDiscoveryPage(f.reader, market, {
      cursor: a.older,
    });
    expect(f.client.readContract).toHaveBeenCalledTimes(20);
    expect(b.anchorBlock).toBe(a.anchorBlock);
    expect(b.listings[0].listingId).toBe("11");
    const back = await readAuctionDiscoveryPage(f.reader, market, {
      cursor: b.newer,
    });
    expect(back.listings).toEqual(a.listings);
  });
  it("excludes an explicitly non-auction type rather than labelling it an auction", async () => {
    const f = fixture();
    f.client.readContract
      .mockResolvedValueOnce(listing(0))
      .mockResolvedValueOnce(listing(1));
    const page = await readAuctionDiscoveryPage(f.reader, market);
    expect(page.nonAuctionCount).toBe(1);
    expect(page.checkedCandidates).toBe(2);
    expect(page.listings).toHaveLength(1);
  });
  it("binds the public seller filter to RPC and every continuation cursor", async () => {
    const f = fixture(12);
    const a = await readAuctionDiscoveryPage(f.reader, market, {
      seller,
      pageSize: 10,
    });
    expect(f.client.getLogs.mock.calls[0][0]).toMatchObject({
      args: { seller },
    });
    expect(a.older?.seller).toBe(seller);
    await expect(
      readAuctionDiscoveryPage(f.reader, market, {
        cursor: a.older,
        seller: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("rejects absent records, seller substitution and malformed scalar/tuple representations", async () => {
    for (const value of [
      listing(1, 0),
      listing(1, 1, market),
      [...listing(), "unexpected"],
      [...listing().slice(0, 5), 1000n, ...listing().slice(6)],
      [...listing().slice(0, 5), 2 ** 48, ...listing().slice(6)],
    ]) {
      const f = fixture(1);
      f.client.readContract.mockResolvedValue(
        value as ReturnType<typeof listing>,
      );
      await expect(
        readAuctionDiscoveryPage(f.reader, market),
      ).rejects.toMatchObject({ code: "MALFORMED" });
    }
  });
  it("does not return partial auctions after a source header, chain or detail read failure", async () => {
    const f = fixture();
    f.client.getBlock.mockImplementation(async (query) =>
      query?.blockNumber === f.all[0].blockNumber
        ? { ...header(query.blockNumber), hash: hash(999999) }
        : header(query?.blockNumber ?? 25005n),
    );
    await expect(
      readAuctionDiscoveryPage(f.reader, market),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const chain = fixture();
    chain.client.getChainId.mockResolvedValueOnce(560048).mockResolvedValue(1);
    await expect(
      readAuctionDiscoveryPage(chain.reader, market),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    const failure = fixture();
    failure.client.readContract.mockRejectedValueOnce(
      Error("synthetic-private-rpc-error"),
    );
    await expect(
      readAuctionDiscoveryPage(failure.reader, market),
    ).rejects.toMatchObject({ message: "UNAVAILABLE", code: "UNAVAILABLE" });
  });
  it("bounds candidate detail concurrency to four and stops launching batches on cancellation", async () => {
    const f = fixture(20);
    let active = 0,
      maximum = 0,
      started!: () => void,
      release!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.client.readContract.mockImplementation(async () => {
      active++;
      maximum = Math.max(active, maximum);
      if (active === 4) started();
      await gate;
      active--;
      return listing();
    });
    const controller = new AbortController(),
      pending = readAuctionDiscoveryPage(f.reader, market, {
        signal: controller.signal,
      });
    await ready;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(maximum).toBe(4);
    expect(f.client.readContract).toHaveBeenCalledTimes(4);
  });
  it("preserves empty-window navigation and refuses dense RPC responses", async () => {
    const empty = fixture(0);
    const page = await readAuctionDiscoveryPage(empty.reader, market);
    expect(page.listings).toEqual([]);
    expect(page.checkedCandidates).toBe(0);
    expect(page.older).not.toBeNull();
    const dense = fixture(1000);
    await expect(
      readAuctionDiscoveryPage(dense.reader, market, { blockSpan: 10000 }),
    ).rejects.toMatchObject({ code: "DENSE_RANGE" });
  });
});
