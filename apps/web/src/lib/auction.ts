import {
  parseAbi,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
  type Hex,
} from "viem";
export const auctionAbi = parseAbi([
  "function listings(uint256) view returns(address seller,address assetToken,address paymentToken,uint256 amountRemaining,uint256 unitPrice,uint48 startsAt,uint48 endsAt,uint8 kind,uint8 state,address highestBidder,uint256 highestBid)",
  "function auctionTerms(uint256) view returns(uint256 reservePrice,uint256 minimumBidIncrement,uint48 endsAt,uint48 extensionWindow,uint48 extensionDuration)",
  "function createAuctionListing(bytes32 requestId,address assetToken,address paymentToken,uint256 amount,uint256 openingBid,uint48 startsAt,uint48 endsAt,uint256 reservePrice,uint256 minimumBidIncrement,uint48 extensionWindow,uint48 extensionDuration) returns(uint256)",
  "function placeBid(uint256 listingId,uint256 bidAmount)",
  "function settleAuction(uint256 listingId)",
  "function cancelListing(uint256 listingId)",
  "function withdrawCredit(address token)",
  "function paused() view returns(bool)",
  "function allowedAssetToken(address) view returns(bool)",
  "function allowedPaymentToken(address) view returns(bool)",
  "function credits(address,address) view returns(uint256)",
  "function pilotPaymentCap(address,address) view returns(uint256)",
  "function pilotPaymentUsed(address,address) view returns(uint256)",
  "event ListingCreated(bytes32 indexed requestId,uint256 indexed listingId,address indexed seller)",
  "event BidPlaced(uint256 indexed listingId,address indexed bidder,uint256 amount)",
  "event AuctionExtended(uint256 indexed listingId,uint48 previousEnd,uint48 extendedEnd)",
  "event ListingSettled(uint256 indexed listingId,address indexed buyer,uint256 payment)",
  "event ListingCancelled(uint256 indexed listingId)",
  "event CreditWithdrawn(address indexed account,address indexed token,uint256 amount)",
]);
export const auctionTokenAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
export type AuctionSnapshot = {
  id: string;
  market: Address;
  seller: Address;
  asset: Address;
  payment: Address;
  amount: bigint;
  openingBid: bigint;
  startsAt: number;
  endsAt: number;
  state: number;
  highestBidder: Address;
  highestBid: bigint;
  reserve: bigint;
  increment: bigint;
  extensionWindow: number;
  extensionDuration: number;
  paused: boolean;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: number;
};
export type AuctionReader = Pick<
  PublicClient,
  "readContract" | "getBlock" | "getChainId" | "getLogs"
>;
export function auctionAmount(value: string, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) ||
    value.length > 116 ||
    (value.split(".")[1]?.length ?? 0) > decimals
  )
    throw new Error(
      "Enter an exact positive token amount without extra decimal places.",
    );
  const result = parseUnits(value, decimals);
  if (result <= 0n || result >= 1n << 256n)
    throw new Error("The token amount is outside the supported range.");
  return result;
}
export function auctionID(value: string) {
  if (!/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 1n << 256n)
    throw new Error("Enter a positive decimal auction ID.");
  return BigInt(value);
}
export function auctionMinimumBid(auction: AuctionSnapshot) {
  return auction.highestBidder.toLowerCase() === zeroAddress
    ? auction.openingBid
    : auction.highestBid + auction.increment;
}
export function auctionActions(auction: AuctionSnapshot, account?: Address) {
  const active = auction.state === 1;
  return {
    bid:
      active &&
      !auction.paused &&
      auction.timestamp >= auction.startsAt &&
      auction.timestamp < auction.endsAt,
    settle: active && auction.timestamp >= auction.endsAt,
    cancel:
      active &&
      auction.highestBidder.toLowerCase() === zeroAddress &&
      auction.seller.toLowerCase() === account?.toLowerCase(),
  };
}
export async function loadAuction(
  client: AuctionReader,
  market: Address,
  id: string,
): Promise<AuctionSnapshot> {
  if ((await client.getChainId()) !== 560048)
    throw new Error("Auction reads require the configured Hoodi chain.");
  const block = await client.getBlock();
  if (block.number === null || !block.hash)
    throw new Error("The auction block is unavailable.");
  const key = auctionID(id);
  const [listing, terms, paused] = await Promise.all([
    client.readContract({
      address: market,
      abi: auctionAbi,
      functionName: "listings",
      args: [key],
      blockNumber: block.number,
    }),
    client.readContract({
      address: market,
      abi: auctionAbi,
      functionName: "auctionTerms",
      args: [key],
      blockNumber: block.number,
    }),
    client.readContract({
      address: market,
      abi: auctionAbi,
      functionName: "paused",
      blockNumber: block.number,
    }),
  ]);
  if (listing[7] !== 1 || listing[8] === 0)
    throw new Error("No auction exists at this ID.");
  return {
    id,
    market,
    seller: listing[0],
    asset: listing[1],
    payment: listing[2],
    amount: listing[3],
    openingBid: listing[4],
    startsAt: Number(listing[5]),
    endsAt: Number(terms[2]),
    state: listing[8],
    highestBidder: listing[9],
    highestBid: listing[10],
    reserve: terms[0],
    increment: terms[1],
    extensionWindow: Number(terms[3]),
    extensionDuration: Number(terms[4]),
    paused,
    blockNumber: block.number,
    blockHash: block.hash,
    timestamp: Number(block.timestamp),
  };
}
export function assertAuctionUnchanged(
  reviewed: AuctionSnapshot,
  current: AuctionSnapshot,
) {
  for (const key of [
    "id",
    "market",
    "seller",
    "asset",
    "payment",
    "amount",
    "openingBid",
    "startsAt",
    "endsAt",
    "state",
    "highestBidder",
    "highestBid",
    "reserve",
    "increment",
    "extensionWindow",
    "extensionDuration",
    "paused",
  ] as const)
    if (reviewed[key] !== current[key])
      throw new Error(
        "Auction terms or bids changed. Refresh and review before confirming.",
      );
}
export async function auctionBidPreflight(
  client: AuctionReader,
  reviewed: AuctionSnapshot,
  bidder: Address,
  amount: bigint,
) {
  const current = await loadAuction(client, reviewed.market, reviewed.id);
  assertAuctionUnchanged(reviewed, current);
  if (!auctionActions(current, bidder).bid)
    throw new Error("This auction is not accepting bids.");
  if (
    amount < auctionMinimumBid(current) ||
    amount <= 0n ||
    amount >= 1n << 256n
  )
    throw new Error("The bid is below the current minimum.");
  const [balance, cap, used, allowed] = await Promise.all([
    client.readContract({
      address: current.payment,
      abi: auctionTokenAbi,
      functionName: "balanceOf",
      args: [bidder],
      blockNumber: current.blockNumber,
    }),
    client.readContract({
      address: current.market,
      abi: auctionAbi,
      functionName: "pilotPaymentCap",
      args: [bidder, current.payment],
      blockNumber: current.blockNumber,
    }),
    client.readContract({
      address: current.market,
      abi: auctionAbi,
      functionName: "pilotPaymentUsed",
      args: [bidder, current.payment],
      blockNumber: current.blockNumber,
    }),
    client.readContract({
      address: current.market,
      abi: auctionAbi,
      functionName: "allowedPaymentToken",
      args: [current.payment],
      blockNumber: current.blockNumber,
    }),
  ]);
  if (!allowed || balance < amount || used + amount > cap)
    throw new Error(
      "Payment permission, balance or the current pilot cap prevents this bid.",
    );
  // A removed snapshot must not supply execution authority.
  const block = await client.getBlock({ blockNumber: current.blockNumber });
  if (block.hash !== current.blockHash)
    throw new Error("The auction observation was reorganized. Refresh it.");
  return current;
}
export async function auctionEvents(
  client: AuctionReader,
  market: Address,
  id?: string,
  fromBlock?: bigint,
) {
  if ((await client.getChainId()) !== 560048)
    throw new Error("Auction history requires the configured Hoodi chain.");
  const head = await client.getBlock();
  if (head.number === null || !head.hash)
    throw new Error("The current auction block is unavailable.");
  const from = fromBlock ?? (head.number > 10000n ? head.number - 10000n : 0n);
  if (from < 0n || from > head.number || head.number - from > 50000n)
    throw new Error("Choose a history range of at most 50,000 blocks.");
  const args = id ? { listingId: auctionID(id) } : undefined;
  const logs = await client.getLogs({
    address: market,
    events: auctionAbi.filter(
      (item) => item.type === "event" && item.name !== "CreditWithdrawn",
    ),
    fromBlock: from,
    toBlock: head.number,
    strict: true,
  });
  const canonical = await client.getBlock({ blockNumber: head.number });
  if (canonical.hash !== head.hash)
    throw new Error("The auction history was reorganized. Refresh it.");
  return {
    fromBlock: from,
    toBlock: head.number,
    logs: logs
      .filter(
        (log) =>
          !log.removed &&
          (!args ||
            ("listingId" in log.args && log.args.listingId === args.listingId)),
      )
      .sort(
        (a, b) =>
          Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex,
      ),
  };
}
