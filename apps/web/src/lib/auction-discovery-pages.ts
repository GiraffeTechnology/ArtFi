import { isAddress, type Address, type Hex } from "viem";
import { auctionAbi, type AuctionReader } from "./auction";
import { decodeAuctionTimeline } from "./auction-observation";
import {
  AuctionDiscoveryError,
  discoveryHash,
  planDiscoveryPage,
  refuseDiscovery,
  snapshotDiscoveryCursor,
  type AuctionCreation,
  type AuctionDiscoveryCursor,
} from "./auction-discovery-model";

export type DiscoveredAuction = Readonly<
  AuctionCreation & {
    state: "active" | "settled" | "cancelled";
    asset: Address;
    payment: Address;
    amountRemaining: string;
    openingBid: string;
    startsAt: number;
    endsAt: number;
  }
>;
export type AuctionDiscoveryPage = Readonly<{
  market: Address;
  seller: Address | null;
  chainId: 560048;
  anchorBlock: bigint;
  anchorHash: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  blockSpan: number;
  pageSize: number;
  listings: readonly DiscoveredAuction[];
  checkedCandidates: number;
  nonAuctionCount: number;
  duplicateCount: number;
  older: AuctionDiscoveryCursor | null;
  newer: AuctionDiscoveryCursor | null;
}>;
type Reader = Pick<
  AuctionReader,
  "getBlock" | "getLogs" | "getChainId" | "readContract"
>;
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) refuseDiscovery("CANCELLED");
};
const bigUint = (v: unknown) =>
  typeof v === "bigint" && v >= 0n && v < 1n << 256n;
const smallUint = (v: unknown, bits: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < 2 ** bits;
function address(value: unknown, allowZero = false): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value) ||
    (!allowZero && /^0x0+$/i.test(value))
  )
    return refuseDiscovery("MALFORMED");
  return value.toLowerCase() as Address;
}
function classifyCreation(
  creation: AuctionCreation,
  raw: unknown,
): DiscoveredAuction | null {
  if (
    !Array.isArray(raw) ||
    raw.length !== 11 ||
    address(raw[0]) !== creation.seller ||
    !bigUint(raw[3]) ||
    !bigUint(raw[4]) ||
    !smallUint(raw[5], 48) ||
    !smallUint(raw[6], 48) ||
    !smallUint(raw[7], 8) ||
    raw[7] > 1 ||
    !smallUint(raw[8], 8) ||
    raw[8] < 1 ||
    raw[8] > 3 ||
    !bigUint(raw[10])
  )
    return refuseDiscovery("MALFORMED");
  const asset = address(raw[1]),
    payment = address(raw[2]);
  address(raw[9], true);
  if (raw[7] === 0) return null; // An old fixed-price record is not an auction.
  if (raw[4] === 0n || raw[5] >= raw[6]) return refuseDiscovery("MALFORMED");
  return Object.freeze({
    ...creation,
    state: raw[8] === 1 ? "active" : raw[8] === 2 ? "settled" : "cancelled",
    asset,
    payment,
    amountRemaining: String(raw[3]),
    openingBid: String(raw[4]),
    startsAt: raw[5],
    endsAt: raw[6],
  });
}

/** Fixed public listing discovery. No balances, approvals, signing or writes. */
export async function readAuctionDiscoveryPage(
  client: Reader,
  marketInput: Address,
  options: {
    cursor?: unknown;
    seller?: string | null;
    blockSpan?: number;
    pageSize?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AuctionDiscoveryPage> {
  const signal = options.signal,
    cursor =
      options.cursor == null ? null : snapshotDiscoveryCursor(options.cursor);
  if (!isAddress(marketInput) || /^0x0+$/i.test(marketInput))
    return refuseDiscovery("INVALID_QUERY");
  const market = marketInput.toLowerCase() as Address;
  const sellerInput =
    options.seller === undefined ? (cursor?.seller ?? null) : options.seller;
  if (
    sellerInput !== null &&
    (typeof sellerInput !== "string" ||
      !isAddress(sellerInput) ||
      /^0x0+$/i.test(sellerInput))
  )
    return refuseDiscovery("INVALID_QUERY");
  const seller =
    sellerInput === null ? null : (sellerInput.toLowerCase() as Address);
  const blockSpan = options.blockSpan ?? cursor?.blockSpan ?? 1000,
    pageSize = options.pageSize ?? cursor?.pageSize ?? 25;
  if (
    !Number.isSafeInteger(blockSpan) ||
    blockSpan < 1 ||
    blockSpan > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  )
    return refuseDiscovery("INVALID_QUERY");
  if (
    cursor &&
    (cursor.market !== market ||
      cursor.seller !== seller ||
      cursor.blockSpan !== blockSpan ||
      cursor.pageSize !== pageSize)
  )
    return refuseDiscovery("INVALID_CURSOR");
  checkAbort(signal);
  try {
    if ((await client.getChainId()) !== 560048)
      return refuseDiscovery("SOURCE_CHANGED");
    checkAbort(signal);
    const head = await client.getBlock(
      cursor ? { blockNumber: BigInt(cursor.anchorBlock) } : undefined,
    );
    checkAbort(signal);
    if (
      !bigUint(head.number) ||
      typeof head.hash !== "string" ||
      !discoveryHash(head.hash.toLowerCase())
    )
      return refuseDiscovery("MALFORMED");
    const anchorBlock = head.number as bigint,
      anchorHash = head.hash.toLowerCase() as Hex;
    if (
      cursor &&
      (anchorBlock !== BigInt(cursor.anchorBlock) ||
        anchorHash !== cursor.anchorHash)
    )
      return refuseDiscovery("SOURCE_CHANGED");
    const windowTo = cursor ? BigInt(cursor.windowTo) : anchorBlock;
    const from =
      windowTo >= BigInt(blockSpan - 1) ? windowTo - BigInt(blockSpan - 1) : 0n;
    const event = auctionAbi.find(
      (item) => item.type === "event" && item.name === "ListingCreated",
    );
    if (!event) return refuseDiscovery("UNAVAILABLE");
    const logs: unknown = await client.getLogs({
      address: market,
      event,
      args: seller ? { seller } : undefined,
      fromBlock: from,
      toBlock: windowTo,
      strict: true,
    });
    checkAbort(signal);
    if (!Array.isArray(logs)) return refuseDiscovery("MALFORMED");
    if (logs.length >= 1000) return refuseDiscovery("DENSE_RANGE");
    const creations: AuctionCreation[] = [];
    for (const raw of logs) {
      if (
        !raw ||
        typeof raw !== "object" ||
        raw.eventName !== "ListingCreated" ||
        !raw.args ||
        typeof raw.args.listingId !== "bigint"
      )
        return refuseDiscovery("MALFORMED");
      let decoded: ReturnType<typeof decodeAuctionTimeline>;
      try {
        decoded = decodeAuctionTimeline(
          [raw],
          market,
          String(raw.args.listingId),
          from,
          windowTo,
        );
      } catch {
        return refuseDiscovery("MALFORMED");
      }
      const entry = decoded.entries[0];
      if (
        !entry ||
        entry.event !== "ListingCreated" ||
        !entry.actor ||
        !entry.requestId
      )
        return refuseDiscovery("MALFORMED");
      creations.push(
        Object.freeze({
          listingId: entry.listingId,
          seller: entry.actor,
          requestId: entry.requestId,
          blockNumber: entry.blockNumber,
          blockHash: entry.blockHash,
          transactionHash: entry.transactionHash,
          logIndex: entry.logIndex,
        }),
      );
    }
    const plan = planDiscoveryPage(creations, cursor, {
      market,
      seller,
      anchorBlock,
      anchorHash,
      windowTo,
      blockSpan,
      pageSize,
    });
    const blocks = new Map<bigint, Hex>();
    for (const c of [
      ...plan.candidates,
      ...(cursor?.boundary
        ? [
            {
              ...cursor.boundary,
              blockNumber: BigInt(cursor.boundary.blockNumber),
            },
          ]
        : []),
    ]) {
      const previous = blocks.get(c.blockNumber);
      if (previous && previous !== c.blockHash)
        return refuseDiscovery("SOURCE_CHANGED");
      blocks.set(c.blockNumber, c.blockHash);
    }
    const headers = [...blocks];
    for (let index = 0; index < headers.length; index += 4) {
      checkAbort(signal);
      const checks = await Promise.allSettled(
        headers.slice(index, index + 4).map(async ([number, hash]) => {
          const block = await client.getBlock({ blockNumber: number });
          if (
            block.number !== number ||
            typeof block.hash !== "string" ||
            block.hash.toLowerCase() !== hash
          )
            return refuseDiscovery("SOURCE_CHANGED");
        }),
      );
      checkAbort(signal);
      for (const check of checks)
        if (check.status !== "fulfilled") throw check.reason;
    }
    const listings: DiscoveredAuction[] = [];
    let nonAuctionCount = 0;
    for (let index = 0; index < plan.candidates.length; index += 4) {
      checkAbort(signal);
      const checked = await Promise.allSettled(
        plan.candidates.slice(index, index + 4).map(async (creation) => {
          const value: unknown = await client.readContract({
            address: market,
            abi: auctionAbi,
            functionName: "listings",
            args: [BigInt(creation.listingId)],
            blockNumber: anchorBlock,
          });
          return classifyCreation(creation, value);
        }),
      );
      checkAbort(signal);
      for (const item of checked) {
        if (item.status !== "fulfilled") throw item.reason;
        if (item.value) listings.push(item.value);
        else nonAuctionCount++;
      }
    }
    const [final, chain] = await Promise.all([
      client.getBlock({ blockNumber: anchorBlock }),
      client.getChainId(),
    ]);
    checkAbort(signal);
    if (
      chain !== 560048 ||
      final.number !== anchorBlock ||
      typeof final.hash !== "string" ||
      final.hash.toLowerCase() !== anchorHash
    )
      return refuseDiscovery("SOURCE_CHANGED");
    return Object.freeze({
      market,
      seller,
      chainId: 560048,
      anchorBlock,
      anchorHash,
      fromBlock: plan.fromBlock,
      toBlock: plan.toBlock,
      blockSpan,
      pageSize,
      listings: Object.freeze(listings),
      checkedCandidates: plan.candidates.length,
      nonAuctionCount,
      duplicateCount: plan.duplicateCount,
      older: plan.older,
      newer: plan.newer,
    });
  } catch (error) {
    checkAbort(signal);
    let known = false;
    try {
      known = error instanceof AuctionDiscoveryError;
    } catch {
      /* Normalize hostile transport errors too. */
    }
    if (known) throw error;
    return refuseDiscovery("UNAVAILABLE");
  }
}
