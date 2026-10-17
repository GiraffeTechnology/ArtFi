import { isAddress, type Address, type Hex } from "viem";
import { auctionAbi, auctionID, type AuctionReader } from "./auction";
import { decodeAuctionTimeline, type AuctionTimelineEntry } from "./auction-observation";

export type AuctionHistoryFailure =
  | "INVALID_QUERY" | "INVALID_CURSOR" | "UNAVAILABLE"
  | "SOURCE_CHANGED" | "DENSE_RANGE" | "MALFORMED" | "CANCELLED";
export class AuctionHistoryPageError extends Error {
  readonly code: AuctionHistoryFailure;
  constructor(code: AuctionHistoryFailure) {
    super(code);
    this.code = code;
  }
}

// Navigation data only. A cursor grants no wallet, session or execution rights.
export type AuctionHistoryCursor = Readonly<{
  version: "auction-history/1";
  chainId: 560048;
  market: Address;
  listingId: string;
  anchorBlock: string;
  anchorHash: Hex;
  nextToBlock: string;
  blockSpan: number;
}>;
export type AuctionHistoryPage = Readonly<{
  market: Address;
  listingId: string;
  chainId: 560048;
  anchorBlock: bigint;
  anchorHash: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  blockSpan: number;
  entries: readonly AuctionTimelineEntry[];
  duplicateCount: number;
  older: AuctionHistoryCursor | null;
  newer: AuctionHistoryCursor | null;
}>;
export type AuctionHistoryReader = Pick<AuctionReader, "getBlock" | "getLogs" | "getChainId">;

const maximumLogs = 1000;
const maximumObservedBlocks = 64;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const uintPattern = /^(0|[1-9][0-9]{0,77})$/;
const fail = (code: AuctionHistoryFailure): never => { throw new AuctionHistoryPageError(code); };
function uint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < 1n << 256n;
}
function hash(value: unknown): value is Hex {
  return typeof value === "string" && hashPattern.test(value) && !/^0x0+$/i.test(value);
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted) fail("CANCELLED");
}

/** Snapshot own cursor data before any asynchronous source read. */
function cursorSnapshot(input: unknown): AuctionHistoryCursor {
  try { return strictCursorSnapshot(input); } catch { return fail("INVALID_CURSOR"); }
}
function strictCursorSnapshot(input: unknown): AuctionHistoryCursor {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return fail("INVALID_CURSOR");
  const keys = ["version", "chainId", "market", "listingId", "anchorBlock", "anchorHash", "nextToBlock", "blockSpan"];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((k) => typeof k !== "string" || !keys.includes(k))) return fail("INVALID_CURSOR");
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return fail("INVALID_CURSOR");
    data[key] = descriptor.value;
  }
  if (data.version !== "auction-history/1" || data.chainId !== 560048 || typeof data.market !== "string" || !isAddress(data.market) || data.market !== data.market.toLowerCase() || typeof data.listingId !== "string" || !/^[1-9][0-9]{0,77}$/.test(data.listingId) || BigInt(data.listingId) >= 1n << 256n || !hash(data.anchorHash) || data.anchorHash !== data.anchorHash.toLowerCase() || !Number.isSafeInteger(data.blockSpan) || (data.blockSpan as number) < 1 || (data.blockSpan as number) > 10000) return fail("INVALID_CURSOR");
  for (const key of ["anchorBlock", "nextToBlock"]) {
    if (typeof data[key] !== "string" || !uintPattern.test(data[key] as string) || BigInt(data[key] as string) >= 1n << 256n) return fail("INVALID_CURSOR");
  }
  const anchor = BigInt(data.anchorBlock as string), to = BigInt(data.nextToBlock as string), span = BigInt(data.blockSpan as number);
  if (to > anchor || (anchor - to) % span !== 0n) return fail("INVALID_CURSOR");
  return Object.freeze({ version: "auction-history/1", chainId: 560048, market: data.market as Address, listingId: data.listingId as string, anchorBlock: data.anchorBlock as string, anchorHash: data.anchorHash as Hex, nextToBlock: data.nextToBlock as string, blockSpan: data.blockSpan as number });
}

function makeCursor(page: { market: Address; listingId: string; anchor: bigint; anchorHash: Hex; span: number }, to: bigint): AuctionHistoryCursor {
  return Object.freeze({ version: "auction-history/1", chainId: 560048, market: page.market, listingId: page.listingId, anchorBlock: page.anchor.toString(), anchorHash: page.anchorHash, nextToBlock: to.toString(), blockSpan: page.span });
}

/** Public observation only. The configured client and market remain the source;
 * no new RPC, wallet call, latest-state fallback or transaction is introduced. */
export async function readAuctionHistoryPage(
  client: AuctionHistoryReader,
  marketInput: Address,
  listingId: string,
  options: { cursor?: unknown; blockSpan?: number; signal?: AbortSignal } = {},
): Promise<AuctionHistoryPage> {
  const signal = options.signal;
  const cursor = options.cursor == null ? null : cursorSnapshot(options.cursor);
  const span = options.blockSpan ?? cursor?.blockSpan ?? 1000;
  if (!isAddress(marketInput) || /^0x0+$/i.test(marketInput) || !Number.isSafeInteger(span) || span < 1 || span > 10000) return fail("INVALID_QUERY");
  let selected: bigint;
  try { selected = auctionID(listingId); } catch { return fail("INVALID_QUERY"); }
  const market = marketInput.toLowerCase() as Address;
  if (cursor && (cursor.market !== market || cursor.listingId !== listingId || cursor.blockSpan !== span)) return fail("INVALID_CURSOR");
  aborted(signal);
  try {
    if (await client.getChainId() !== 560048) return fail("SOURCE_CHANGED");
    aborted(signal);
    const initial = await client.getBlock(cursor ? { blockNumber: BigInt(cursor.anchorBlock) } : undefined);
    aborted(signal);
    if (!uint(initial.number) || !hash(initial.hash)) return fail("MALFORMED");
    const anchor = initial.number, anchorHash = initial.hash.toLowerCase() as Hex;
    if (cursor && (anchor !== BigInt(cursor.anchorBlock) || anchorHash !== cursor.anchorHash)) return fail("SOURCE_CHANGED");
    const to = cursor ? BigInt(cursor.nextToBlock) : anchor;
    const from = to >= BigInt(span - 1) ? to - BigInt(span - 1) : 0n;
    const events = auctionAbi.filter((item) => item.type === "event" && item.name !== "CreditWithdrawn");
    // A separate fixed event query allows its actual indexed listingId filter.
    // The multi-event RPC form has no shared args filter in the existing SDK.
    const results = await Promise.allSettled(events.map(async (event) => {
      aborted(signal);
      const value: unknown = await client.getLogs({ address: market, event, args: { listingId: selected }, fromBlock: from, toBlock: to, strict: true });
      aborted(signal);
      if (!Array.isArray(value)) return fail("MALFORMED");
      // Do not silently treat a response at a common RPC cap as complete.
      if (value.length >= maximumLogs) return fail("DENSE_RANGE");
      for (const raw of value) {
        if (!raw || typeof raw !== "object" || raw.eventName !== event.name || !raw.args || typeof raw.args !== "object" || raw.args.listingId !== selected) return fail("MALFORMED");
      }
      return value;
    }));
    aborted(signal);
    const logs: unknown[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") throw result.reason;
      if (logs.length + result.value.length >= maximumLogs) return fail("DENSE_RANGE");
      logs.push(...result.value);
    }
    let decoded: ReturnType<typeof decodeAuctionTimeline>;
    try { decoded = decodeAuctionTimeline(logs, market, listingId, from, to); } catch { return fail("MALFORMED"); }
    const blocks = new Map<bigint, Hex>(), positions = new Map<string, Hex>();
    for (const entry of decoded.entries) {
      if (!hash(entry.blockHash) || !hash(entry.transactionHash)) return fail("MALFORMED");
      const known = blocks.get(entry.blockNumber);
      if (known && known !== entry.blockHash) return fail("SOURCE_CHANGED");
      blocks.set(entry.blockNumber, entry.blockHash);
      const position = `${entry.blockNumber}:${entry.logIndex}`, oldTransaction = positions.get(position);
      if (oldTransaction && oldTransaction !== entry.transactionHash) return fail("MALFORMED");
      positions.set(position, entry.transactionHash);
    }
    if (blocks.size > maximumObservedBlocks) return fail("DENSE_RANGE");
    const identities = [...blocks];
    // Bound concurrent header reads and drain each batch before another starts.
    for (let offset = 0; offset < identities.length; offset += 4) {
      aborted(signal);
      const checks = await Promise.allSettled(identities.slice(offset, offset + 4).map(async ([number, expectedHash]) => {
        const block = await client.getBlock({ blockNumber: number });
        if (block.number !== number || !hash(block.hash) || block.hash.toLowerCase() !== expectedHash) return fail("SOURCE_CHANGED");
      }));
      aborted(signal);
      for (const check of checks) if (check.status !== "fulfilled") throw check.reason;
    }
    const [canonical, chain] = await Promise.all([client.getBlock({ blockNumber: anchor }), client.getChainId()]);
    aborted(signal);
    if (chain !== 560048 || canonical.number !== anchor || !hash(canonical.hash) || canonical.hash.toLowerCase() !== anchorHash) return fail("SOURCE_CHANGED");
    const base = { market, listingId, anchor, anchorHash, span };
    return Object.freeze({ market, listingId, chainId: 560048, anchorBlock: anchor, anchorHash, fromBlock: from, toBlock: to, blockSpan: span, entries: decoded.entries, duplicateCount: decoded.duplicateCount, older: from > 0n ? makeCursor(base, from - 1n) : null, newer: to < anchor ? makeCursor(base, to + BigInt(span) < anchor ? to + BigInt(span) : anchor) : null });
  } catch (error) {
    aborted(signal);
    if (error instanceof AuctionHistoryPageError) throw error;
    return fail("UNAVAILABLE");
  }
}
