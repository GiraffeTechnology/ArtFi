import type { Address, Hex } from "viem";
import type { PublicHistoryFailure } from "./public-block-history-pager";

export class AuctionDiscoveryError extends Error {
  readonly code: PublicHistoryFailure;
  constructor(code: PublicHistoryFailure) {
    super(code);
    this.code = code;
  }
}
export const refuseDiscovery = (code: PublicHistoryFailure): never => {
  throw new AuctionDiscoveryError(code);
};
export type AuctionCreation = Readonly<{
  listingId: string;
  seller: Address;
  requestId: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}>;
type Boundary = Readonly<
  Omit<AuctionCreation, "blockNumber"> & { blockNumber: string }
>;
export type AuctionDiscoveryCursor = Readonly<{
  version: "auction-discovery/1";
  chainId: 560048;
  market: Address;
  seller: Address | null;
  anchorBlock: string;
  anchorHash: Hex;
  windowTo: string;
  blockSpan: number;
  pageSize: number;
  direction: "older" | "newer";
  boundary: Boundary | null;
}>;
export type DiscoveryWindow = Readonly<{
  market: Address;
  seller: Address | null;
  anchorBlock: bigint;
  anchorHash: Hex;
  windowTo: bigint;
  blockSpan: number;
  pageSize: number;
}>;
const uintPattern = /^(0|[1-9][0-9]{0,77})$/;
export function discoveryUint(
  value: unknown,
  positive = false,
): value is string {
  return (
    typeof value === "string" &&
    uintPattern.test(value) &&
    BigInt(value) < 1n << 256n &&
    (!positive || value !== "0")
  );
}
export function discoveryHash(value: unknown): value is Hex {
  return (
    typeof value === "string" &&
    /^0x[0-9a-f]{64}$/.test(value) &&
    !/^0x0+$/.test(value)
  );
}
export function discoveryAddress(value: unknown): value is Address {
  return (
    typeof value === "string" &&
    /^0x[0-9a-f]{40}$/.test(value) &&
    !/^0x0+$/.test(value)
  );
}
function ownData(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return refuseDiscovery("INVALID_CURSOR");
  const descriptors = Object.getOwnPropertyDescriptors(value),
    names = Reflect.ownKeys(descriptors);
  if (
    names.length !== keys.length ||
    names.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return refuseDiscovery("INVALID_CURSOR");
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      return refuseDiscovery("INVALID_CURSOR");
    out[key] = descriptor.value;
  }
  return out;
}
function boundarySnapshot(input: unknown): Boundary {
  const b = ownData(input, [
    "listingId",
    "seller",
    "requestId",
    "blockNumber",
    "blockHash",
    "transactionHash",
    "logIndex",
  ]);
  if (
    !discoveryUint(b.listingId, true) ||
    !discoveryAddress(b.seller) ||
    !discoveryHash(b.requestId) ||
    !discoveryUint(b.blockNumber) ||
    !discoveryHash(b.blockHash) ||
    !discoveryHash(b.transactionHash) ||
    !Number.isInteger(b.logIndex) ||
    (b.logIndex as number) < 0 ||
    (b.logIndex as number) > 4294967295
  )
    return refuseDiscovery("INVALID_CURSOR");
  return Object.freeze({
    listingId: b.listingId,
    seller: b.seller,
    requestId: b.requestId,
    blockNumber: b.blockNumber,
    blockHash: b.blockHash,
    transactionHash: b.transactionHash,
    logIndex: b.logIndex as number,
  });
}

// These snapshots are navigation data, never source or transaction authority.
export function snapshotDiscoveryCursor(
  input: unknown,
): AuctionDiscoveryCursor {
  try {
    const c = ownData(input, [
      "version",
      "chainId",
      "market",
      "seller",
      "anchorBlock",
      "anchorHash",
      "windowTo",
      "blockSpan",
      "pageSize",
      "direction",
      "boundary",
    ]);
    if (
      c.version !== "auction-discovery/1" ||
      c.chainId !== 560048 ||
      !discoveryAddress(c.market) ||
      (c.seller !== null && !discoveryAddress(c.seller)) ||
      !discoveryUint(c.anchorBlock) ||
      !discoveryHash(c.anchorHash) ||
      !discoveryUint(c.windowTo) ||
      !Number.isSafeInteger(c.blockSpan) ||
      (c.blockSpan as number) < 1 ||
      (c.blockSpan as number) > 10000 ||
      !Number.isSafeInteger(c.pageSize) ||
      (c.pageSize as number) < 1 ||
      (c.pageSize as number) > 50 ||
      (c.direction !== "older" && c.direction !== "newer")
    )
      return refuseDiscovery("INVALID_CURSOR");
    const anchor = BigInt(c.anchorBlock),
      to = BigInt(c.windowTo),
      span = c.blockSpan as number;
    if (to > anchor || (anchor - to) % BigInt(span) !== 0n)
      return refuseDiscovery("INVALID_CURSOR");
    const boundary = c.boundary === null ? null : boundarySnapshot(c.boundary);
    const from = to >= BigInt(span - 1) ? to - BigInt(span - 1) : 0n;
    if (
      boundary &&
      (BigInt(boundary.blockNumber) < from ||
        BigInt(boundary.blockNumber) > to ||
        (c.seller !== null && boundary.seller !== c.seller))
    )
      return refuseDiscovery("INVALID_CURSOR");
    return Object.freeze({
      version: "auction-discovery/1",
      chainId: 560048,
      market: c.market,
      seller: c.seller as Address | null,
      anchorBlock: c.anchorBlock,
      anchorHash: c.anchorHash,
      windowTo: c.windowTo,
      blockSpan: span,
      pageSize: c.pageSize as number,
      direction: c.direction,
      boundary,
    });
  } catch {
    return refuseDiscovery("INVALID_CURSOR");
  }
}
const sameCreation = (a: AuctionCreation, b: AuctionCreation) =>
  a.listingId === b.listingId &&
  a.seller === b.seller &&
  a.requestId === b.requestId &&
  a.blockNumber === b.blockNumber &&
  a.blockHash === b.blockHash &&
  a.transactionHash === b.transactionHash &&
  a.logIndex === b.logIndex;
const asBoundary = (e: AuctionCreation): Boundary =>
  Object.freeze({ ...e, blockNumber: e.blockNumber.toString() });
function cursorFor(
  w: DiscoveryWindow,
  to: bigint,
  direction: "older" | "newer",
  boundary: AuctionCreation | null,
): AuctionDiscoveryCursor {
  return Object.freeze({
    version: "auction-discovery/1",
    chainId: 560048,
    market: w.market,
    seller: w.seller,
    anchorBlock: w.anchorBlock.toString(),
    anchorHash: w.anchorHash,
    windowTo: to.toString(),
    blockSpan: w.blockSpan,
    pageSize: w.pageSize,
    direction,
    boundary: boundary ? asBoundary(boundary) : null,
  });
}

/** Bounded content/navigation comparison. The reader separately verifies actual
 * headers and listing types; this arithmetic establishes no chain authority. */
export function planDiscoveryPage(
  input: readonly AuctionCreation[],
  navigation: AuctionDiscoveryCursor | null,
  w: DiscoveryWindow,
) {
  if (input.length >= 1000) return refuseDiscovery("DENSE_RANGE");
  if (
    !discoveryAddress(w.market) ||
    (w.seller !== null && !discoveryAddress(w.seller)) ||
    !discoveryHash(w.anchorHash) ||
    !discoveryUint(w.anchorBlock.toString()) ||
    !discoveryUint(w.windowTo.toString()) ||
    w.windowTo > w.anchorBlock ||
    !Number.isSafeInteger(w.blockSpan) ||
    w.blockSpan < 1 ||
    w.blockSpan > 10000 ||
    !Number.isSafeInteger(w.pageSize) ||
    w.pageSize < 1 ||
    w.pageSize > 50 ||
    (w.anchorBlock - w.windowTo) % BigInt(w.blockSpan) !== 0n
  )
    return refuseDiscovery("INVALID_QUERY");
  if (
    navigation &&
    (navigation.market !== w.market ||
      navigation.seller !== w.seller ||
      navigation.anchorBlock !== w.anchorBlock.toString() ||
      navigation.anchorHash !== w.anchorHash ||
      navigation.windowTo !== w.windowTo.toString() ||
      navigation.blockSpan !== w.blockSpan ||
      navigation.pageSize !== w.pageSize)
  )
    return refuseDiscovery("INVALID_CURSOR");
  const from =
    w.windowTo >= BigInt(w.blockSpan - 1)
      ? w.windowTo - BigInt(w.blockSpan - 1)
      : 0n;
  const seen = new Map<string, AuctionCreation>(),
    positions = new Map<string, string>(),
    listingIds = new Map<string, string>();
  let duplicateCount = 0;
  for (const e of input) {
    if (
      !discoveryUint(e.listingId, true) ||
      !discoveryAddress(e.seller) ||
      !discoveryHash(e.requestId) ||
      typeof e.blockNumber !== "bigint" ||
      e.blockNumber < from ||
      e.blockNumber > w.windowTo ||
      !discoveryHash(e.blockHash) ||
      !discoveryHash(e.transactionHash) ||
      !Number.isInteger(e.logIndex) ||
      e.logIndex < 0 ||
      e.logIndex > 4294967295 ||
      (w.seller !== null && e.seller !== w.seller)
    )
      return refuseDiscovery("MALFORMED");
    const key = `${e.transactionHash}:${e.logIndex}`,
      position = `${e.blockNumber}:${e.logIndex}`,
      existing = seen.get(key);
    if (existing) {
      if (!sameCreation(existing, e)) return refuseDiscovery("MALFORMED");
      duplicateCount++;
      continue;
    }
    if (positions.has(position) || listingIds.has(e.listingId))
      return refuseDiscovery("MALFORMED");
    seen.set(key, e);
    positions.set(position, key);
    listingIds.set(e.listingId, key);
  }
  const all = [...seen.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex
      : a.blockNumber > b.blockNumber
        ? -1
        : 1,
  );
  const direction = navigation?.direction ?? "older";
  let first = 0,
    end = all.length;
  if (navigation?.boundary) {
    const b = navigation.boundary;
    const index = all.findIndex((e) =>
      sameCreation(e, { ...b, blockNumber: BigInt(b.blockNumber) }),
    );
    if (index < 0) return refuseDiscovery("SOURCE_CHANGED");
    if (direction === "older") first = index + 1;
    else end = index;
    if (first === end) return refuseDiscovery("SOURCE_CHANGED");
  }
  const start =
    direction === "older" ? first : Math.max(first, end - w.pageSize);
  const stop = direction === "older" ? Math.min(end, start + w.pageSize) : end;
  const candidates = Object.freeze(
    all.slice(start, stop).map((e) => Object.freeze({ ...e })),
  );
  const older =
    candidates.length && stop < all.length
      ? cursorFor(w, w.windowTo, "older", candidates[candidates.length - 1])
      : from > 0n
        ? cursorFor(w, from - 1n, "older", null)
        : null;
  const nextWindow =
    w.windowTo + BigInt(w.blockSpan) < w.anchorBlock
      ? w.windowTo + BigInt(w.blockSpan)
      : w.anchorBlock;
  const newer =
    candidates.length && start > 0
      ? cursorFor(w, w.windowTo, "newer", candidates[0])
      : w.windowTo < w.anchorBlock
        ? cursorFor(w, nextWindow, "newer", null)
        : null;
  return Object.freeze({
    candidates,
    fromBlock: from,
    toBlock: w.windowTo,
    older,
    newer,
    duplicateCount,
  });
}
