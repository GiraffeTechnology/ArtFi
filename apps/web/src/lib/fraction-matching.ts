import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { artFiFractionMarketAbi, fractionTokenAbi } from "./contracts";
import { anyFractionBuyer, type FractionSaleIntent } from "./fraction-intent";
import { decodeNativeOrder, type NativeOrder } from "./native-order";
import { verifyMarketSignature } from "./market-signature";

const maxUint256 = (1n << 256n) - 1n;
export type FractionMatchRequest = {
  market: Address;
  asset: Address;
  paymentToken: Address;
  buyer: Address;
  amount: bigint;
  maxPayment: bigint;
  /** Omit for market execution against the reviewed book; maximum total payment still applies. */
  maxUnitPrice?: bigint;
};
export type FractionCandidate = {
  order: NativeOrder;
  intent: FractionSaleIntent;
};
export type FractionLiquidity = {
  filled: bigint;
  epoch: bigint;
  balance: bigint;
  allowance: bigint;
  signatureValid: boolean;
};
export type FractionMatch = FractionCandidate & {
  amount: bigint;
  payment: bigint;
};
export type FractionMatchPlan = {
  matches: FractionMatch[];
  requested: bigint;
  matched: bigint;
  unfilled: bigint;
  payment: bigint;
};

function validUint(value: bigint, positive = true) {
  return value >= (positive ? 1n : 0n) && value <= maxUint256;
}
export function validateFractionMatchRequest(request: FractionMatchRequest) {
  if (
    [request.market, request.asset, request.paymentToken, request.buyer].some(
      (value) => !isAddress(value) || value.toLowerCase() === anyFractionBuyer,
    ) ||
    !validUint(request.amount) ||
    !validUint(request.maxPayment) ||
    (request.maxUnitPrice !== undefined && !validUint(request.maxUnitPrice))
  )
    throw new Error(
      "Enter a valid token pair, quantity, payment limit and optional unit-price limit.",
    );
}

/** Preserve sub-millisecond publication ordering; Date.parse alone loses MySQL microseconds. */
function publicationTime(value: string | undefined) {
  const match = value?.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/,
  );
  if (!match)
    throw new Error("The authoritative publication time is unavailable.");
  const seconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(seconds))
    throw new Error("The publication time is invalid.");
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

export function rankFractionCandidates(
  orders: readonly NativeOrder[],
  request: FractionMatchRequest,
) {
  const hashes = new Set<string>();
  const candidates = orders.map((order) => {
    const decoded = decodeNativeOrder(order);
    if (
      decoded.kind !== "fraction" ||
      decoded.order.marketAddress !== request.market.toLowerCase() ||
      decoded.intent.assetToken !== request.asset.toLowerCase() ||
      decoded.intent.paymentToken !== request.paymentToken.toLowerCase() ||
      hashes.has(decoded.order.intentHash)
    )
      throw new Error(
        "The book contains a different pair or duplicate authorization.",
      );
    hashes.add(decoded.order.intentHash);
    return {
      order: decoded.order,
      intent: decoded.intent,
      published: publicationTime(decoded.order.createdAt),
    };
  });
  return candidates.sort((a, b) => {
    if (a.intent.unitPrice !== b.intent.unitPrice)
      return a.intent.unitPrice < b.intent.unitPrice ? -1 : 1;
    if (a.published !== b.published) return a.published < b.published ? -1 : 1;
    return a.order.intentHash < b.order.intentHash ? -1 : 1;
  });
}

/** Deterministic replay over the immutable order log plus one explicit chain snapshot. */
export function planFractionMatches({
  orders,
  request,
  at,
  liquidity,
  paymentAvailable,
}: {
  orders: readonly NativeOrder[];
  request: FractionMatchRequest;
  at: bigint;
  liquidity: ReadonlyMap<string, FractionLiquidity>;
  paymentAvailable: bigint;
}): FractionMatchPlan {
  validateFractionMatchRequest(request);
  if (at < 0n || at >= 1n << 48n)
    throw new Error("The chain snapshot time is invalid.");
  if (!validUint(paymentAvailable, false))
    throw new Error("Buyer payment availability is invalid.");
  const candidates = rankFractionCandidates(orders, request);
  let remaining = request.amount;
  let budget =
    request.maxPayment < paymentAvailable
      ? request.maxPayment
      : paymentAvailable;
  const matches: FractionMatch[] = [];
  const sellerConsumption = new Map<string, bigint>();
  for (const { order, intent } of candidates) {
    if (remaining === 0n) break;
    if (
      request.maxUnitPrice !== undefined &&
      intent.unitPrice > request.maxUnitPrice
    )
      break;
    if (
      intent.seller === request.buyer.toLowerCase() ||
      (intent.buyer !== anyFractionBuyer &&
        intent.buyer !== request.buyer.toLowerCase()) ||
      at < BigInt(intent.startsAt) ||
      at >= BigInt(intent.endsAt)
    )
      continue;
    const state = liquidity.get(order.intentHash);
    if (!state)
      throw new Error(
        "A candidate's chain state is unavailable; matching was stopped.",
      );
    if (
      [state.filled, state.epoch, state.balance, state.allowance].some(
        (value) => !validUint(value, false),
      )
    )
      throw new Error("The observed chain state is invalid.");
    if (
      !state.signatureValid ||
      state.epoch !== intent.epoch ||
      state.filled >= intent.maxAmount
    )
      continue;
    const consumed = sellerConsumption.get(intent.seller) ?? 0n;
    const capacity =
      (state.balance < state.allowance ? state.balance : state.allowance) -
      consumed;
    if (capacity <= 0n) continue;
    let amount = intent.maxAmount - state.filled;
    for (const cap of [remaining, capacity, budget / intent.unitPrice])
      if (amount > cap) amount = cap;
    if (amount === 0n) continue;
    const payment = amount * intent.unitPrice;
    matches.push({ order, intent, amount, payment });
    remaining -= amount;
    budget -= payment;
    sellerConsumption.set(intent.seller, consumed + amount);
  }
  return {
    matches,
    requested: request.amount,
    matched: request.amount - remaining,
    unfilled: remaining,
    payment: matches.reduce((sum, match) => sum + match.payment, 0n),
  };
}

type Reader = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "readContract" | "getCode" | "call"
>;
export type ObservedFractionMatchPlan = FractionMatchPlan & {
  blockNumber: bigint;
  blockHash: Hex;
  logHash: Hex;
};

export async function readFractionMatchPlan(
  client: Reader,
  request: FractionMatchRequest,
  loadBook: (at: bigint) => Promise<unknown>,
): Promise<ObservedFractionMatchPlan> {
  validateFractionMatchRequest(request);
  if ((await client.getChainId()) !== 560048)
    throw new Error("The book reader is on a different chain.");
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null || !block.hash || block.timestamp >= 1n << 48n)
    throw new Error("A mined chain snapshot is unavailable.");
  const body = await loadBook(block.timestamp);
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !Array.isArray(body.data) ||
    body.data.length > 500 ||
    !("at" in body) ||
    body.at !== Number(block.timestamp) ||
    !("logHash" in body) ||
    typeof body.logHash !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(body.logHash) ||
    !("priority" in body) ||
    body.priority !== "price-time-hash"
  )
    throw new Error("The fraction order log is incomplete or malformed.");
  const candidates = rankFractionCandidates(body.data, request);
  const market = {
    address: request.market,
    abi: artFiFractionMarketAbi,
    blockNumber: block.number,
  } as const;
  const [paused, assetAllowed, paymentAllowed, cap, spent, buyerBalance] =
    await Promise.all([
      client.readContract({ ...market, functionName: "paused" }),
      client.readContract({
        ...market,
        functionName: "allowedAssetToken",
        args: [request.asset],
      }),
      client.readContract({
        ...market,
        functionName: "allowedPaymentToken",
        args: [request.paymentToken],
      }),
      client.readContract({
        ...market,
        functionName: "pilotPaymentCap",
        args: [request.buyer, request.paymentToken],
      }),
      client.readContract({
        ...market,
        functionName: "pilotPaymentUsed",
        args: [request.buyer, request.paymentToken],
      }),
      client.readContract({
        address: request.paymentToken,
        abi: fractionTokenAbi,
        functionName: "balanceOf",
        args: [request.buyer],
        blockNumber: block.number,
      }),
    ]);
  if (paused || !assetAllowed || !paymentAllowed)
    throw new Error("The market or token pair is unavailable for settlement.");
  const headroom = cap > spent ? cap - spent : 0n;
  const paymentAvailable = buyerBalance < headroom ? buyerBalance : headroom;
  const sellers = new Map<
    string,
    Promise<{ epoch: bigint; balance: bigint; allowance: bigint }>
  >();
  const liquidity = new Map<string, FractionLiquidity>();
  const read = async ({ order, intent }: FractionCandidate) => {
    if (
      intent.seller === request.buyer.toLowerCase() ||
      (intent.buyer !== anyFractionBuyer &&
        intent.buyer !== request.buyer.toLowerCase()) ||
      block.timestamp < BigInt(intent.startsAt) ||
      block.timestamp >= BigInt(intent.endsAt) ||
      (request.maxUnitPrice !== undefined &&
        intent.unitPrice > request.maxUnitPrice)
    )
      return;
    if (!sellers.has(intent.seller))
      sellers.set(
        intent.seller,
        (async () => {
          const token = {
            address: request.asset,
            abi: fractionTokenAbi,
            blockNumber: block.number!,
          } as const;
          const [epoch, balance, allowance] = await Promise.all([
            client.readContract({
              ...market,
              functionName: "sellerEpoch",
              args: [intent.seller],
            }),
            client.readContract({
              ...token,
              functionName: "balanceOf",
              args: [intent.seller],
            }),
            client.readContract({
              ...token,
              functionName: "allowance",
              args: [intent.seller, request.market],
            }),
          ]);
          return { epoch, balance, allowance };
        })(),
      );
    const [seller, filled, signatureValid] = await Promise.all([
      sellers.get(intent.seller)!,
      client.readContract({
        ...market,
        functionName: "intentFilled",
        args: [order.intentHash],
      }),
      verifyMarketSignature(
        client,
        intent.seller,
        request.market,
        order.intentHash,
        order.signature,
        block.number!,
      ),
    ]);
    liquidity.set(order.intentHash, { ...seller, filled, signatureValid });
  };
  // Bounded RPC fan-out; a failed read fails the complete plan rather than privileging reachable sellers.
  for (let offset = 0; offset < candidates.length; offset += 8)
    await Promise.all(candidates.slice(offset, offset + 8).map(read));
  const checked = await client.getBlock({ blockNumber: block.number });
  if (checked.hash !== block.hash)
    throw new Error(
      "The observed block changed. Refresh the book before trading.",
    );
  return {
    ...planFractionMatches({
      orders: candidates.map(({ order }) => order),
      request,
      at: block.timestamp,
      liquidity,
      paymentAvailable,
    }),
    blockNumber: block.number,
    blockHash: block.hash,
    logHash: body.logHash as Hex,
  };
}
