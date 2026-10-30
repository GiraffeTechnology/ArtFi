import { isAddress, type Address, type Hex } from "viem";
import {
  auctionAbi,
  auctionID,
  loadAuction,
  type AuctionReader,
  type AuctionSnapshot,
} from "./auction";

export type AuctionTimelineEntry = Readonly<{
  sourceKey: string;
  event:
    | "ListingCreated"
    | "BidPlaced"
    | "AuctionExtended"
    | "ListingSettled"
    | "ListingCancelled";
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  listingId: string;
  requestId?: Hex;
  actor?: Address;
  amount?: string;
  previousEnd?: string;
  extendedEnd?: string;
}>;
export type AuctionObservation = Readonly<{
  snapshot: AuctionSnapshot;
  entries: readonly AuctionTimelineEntry[];
  fromBlock: bigint;
  toBlock: bigint;
  duplicateCount: number;
}>;

const hashPattern = /^0x[0-9a-fA-F]{64}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The auction history response is malformed.");
  return value as Record<string, unknown>;
}
function uint(value: unknown, bits: number): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits))
    throw new Error("An auction event contains an invalid integer.");
  return value;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error("An auction event contains an invalid address.");
  return value.toLowerCase() as Address;
}
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !hashPattern.test(value))
    throw new Error("An auction event contains an invalid source hash.");
  return value.toLowerCase() as Hex;
}

/** Decode only the fixed auction ABI. Removed/conflicting/misbound responses
 * are unavailable observations, never an empty successful auction history. */
export function decodeAuctionTimeline(
  value: unknown,
  market: Address,
  listingId: string,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const selected = auctionID(listingId);
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    fromBlock < 0n ||
    toBlock < fromBlock ||
    toBlock - fromBlock > 10000n
  )
    throw new Error("The auction history range or response is unavailable.");
  const seen = new Map<string, string>();
  const entries: AuctionTimelineEntry[] = [];
  let duplicateCount = 0;
  for (const raw of value) {
    const log = record(raw),
      args = record(log.args);
    if (
      address(log.address) !== market.toLowerCase() ||
      log.removed !== false ||
      typeof log.logIndex !== "number" ||
      !Number.isInteger(log.logIndex) ||
      log.logIndex < 0 ||
      log.logIndex > 4294967295
    )
      throw new Error("The auction event source does not match this view.");
    const blockNumber = uint(log.blockNumber, 256);
    if (blockNumber < fromBlock || blockNumber > toBlock)
      throw new Error("The auction event falls outside the requested blocks.");
    const eventId = uint(args.listingId, 256);
    if (eventId === 0n)
      throw new Error("The auction event has no listing identity.");
    const transactionHash = hash(log.transactionHash),
      blockHash = hash(log.blockHash);
    const common = {
      sourceKey: `560048:${transactionHash}:${log.logIndex}`,
      transactionHash,
      blockHash,
      blockNumber,
      logIndex: log.logIndex,
      listingId: eventId.toString(),
    };
    let item: AuctionTimelineEntry;
    let allowed: string[];
    switch (log.eventName) {
      case "ListingCreated":
        allowed = ["requestId", "listingId", "seller"];
        item = {
          ...common,
          event: "ListingCreated",
          requestId: hash(args.requestId),
          actor: address(args.seller),
        };
        break;
      case "BidPlaced":
        allowed = ["listingId", "bidder", "amount"];
        item = {
          ...common,
          event: "BidPlaced",
          actor: address(args.bidder),
          amount: uint(args.amount, 256).toString(),
        };
        break;
      case "AuctionExtended":
        allowed = ["listingId", "previousEnd", "extendedEnd"];
        if (uint(args.extendedEnd, 48) <= uint(args.previousEnd, 48))
          throw new Error("The auction extension does not advance its end.");
        item = {
          ...common,
          event: "AuctionExtended",
          previousEnd: args.previousEnd!.toString(),
          extendedEnd: args.extendedEnd!.toString(),
        };
        break;
      case "ListingSettled":
        allowed = ["listingId", "buyer", "payment"];
        item = {
          ...common,
          event: "ListingSettled",
          actor: address(args.buyer),
          amount: uint(args.payment, 256).toString(),
        };
        break;
      case "ListingCancelled":
        allowed = ["listingId"];
        item = { ...common, event: "ListingCancelled" };
        break;
      default:
        throw new Error("An unsupported auction event was returned.");
    }
    if (
      Object.keys(args).length !== allowed.length ||
      Object.keys(args).some((key) => !allowed.includes(key))
    )
      throw new Error(
        "The auction event arguments do not match the fixed ABI.",
      );
    const fingerprint = JSON.stringify({
      ...item,
      blockNumber: item.blockNumber.toString(),
    });
    const previous = seen.get(item.sourceKey);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        throw new Error(
          "Conflicting auction event identities require a fresh observation.",
        );
      duplicateCount++;
      continue;
    }
    seen.set(item.sourceKey, fingerprint);
    if (eventId === selected) entries.push(Object.freeze(item));
  }
  entries.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex
      : a.blockNumber > b.blockNumber
        ? -1
        : 1,
  );
  return { entries: Object.freeze(entries), duplicateCount };
}

export async function readAuctionObservation(
  client: AuctionReader,
  market: Address,
  listingId: string,
): Promise<AuctionObservation> {
  const snapshot = await loadAuction(client, market, listingId);
  hash(snapshot.blockHash);
  uint(snapshot.blockNumber, 256);
  for (const value of [
    snapshot.amount,
    snapshot.openingBid,
    snapshot.highestBid,
    snapshot.reserve,
    snapshot.increment,
  ])
    uint(value, 256);
  for (const value of [
    snapshot.timestamp,
    snapshot.startsAt,
    snapshot.endsAt,
    snapshot.extensionWindow,
    snapshot.extensionDuration,
  ])
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 48)
      throw new Error("The auction timestamps are malformed.");
  const fromBlock =
    snapshot.blockNumber > 10000n ? snapshot.blockNumber - 10000n : 0n;
  const logs: unknown = await client.getLogs({
    address: market,
    events: auctionAbi.filter(
      (item) => item.type === "event" && item.name !== "CreditWithdrawn",
    ),
    fromBlock,
    toBlock: snapshot.blockNumber,
    strict: true,
  });
  const history = decodeAuctionTimeline(
    logs,
    market,
    listingId,
    fromBlock,
    snapshot.blockNumber,
  );
  const [canonical, chain] = await Promise.all([
    client.getBlock({ blockNumber: snapshot.blockNumber }),
    client.getChainId(),
  ]);
  if (
    chain !== 560048 ||
    canonical.hash?.toLowerCase() !== snapshot.blockHash.toLowerCase()
  )
    throw new Error(
      "The auction observation was reorganized or changed chains.",
    );
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    ...history,
    fromBlock,
    toBlock: snapshot.blockNumber,
  });
}

/** Display estimate only. It never determines bid/settlement eligibility. */
export function auctionCountdown(
  snapshot: AuctionSnapshot,
  observedAt: number,
  now: number,
) {
  if (snapshot.state !== 1) return { phase: "closed" as const, seconds: 0 };
  if (
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(now) ||
    now < observedAt ||
    now - observedAt > 30000 ||
    !Number.isSafeInteger(snapshot.timestamp)
  )
    return { phase: "unavailable" as const, seconds: 0 };
  const estimate = snapshot.timestamp + Math.floor((now - observedAt) / 1000);
  if (estimate < snapshot.startsAt)
    return { phase: "starts" as const, seconds: snapshot.startsAt - estimate };
  return {
    phase: "ends" as const,
    seconds: Math.max(0, snapshot.endsAt - estimate),
  };
}
