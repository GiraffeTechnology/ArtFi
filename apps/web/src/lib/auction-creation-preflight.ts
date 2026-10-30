import {
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { auctionAbi, auctionTokenAbi } from "./auction";
import { assertRwaTradingEvidence } from "./rwa-catalog";

export type AuctionCreationReview = Readonly<{
  market: Address;
  seller: Address;
  asset: Address;
  payment: Address;
  requestId: Hex;
  amount: bigint;
  opening: bigint;
  reserve: bigint;
  increment: bigint;
  starts: number;
  ends: number;
  extension: number;
  sourceSlug: string;
  sourceIdentity: string;
}>;
export type AuctionCreationReader = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "readContract"
>;
const readTimeoutMs = 12_000;
class AuctionCreationCheckError extends Error {}
function refuse(message: string): never {
  throw new AuctionCreationCheckError(message);
}
function uint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value < 1n << 256n;
}
function snapshot(review: AuctionCreationReview): AuctionCreationReview {
  const value = Object.freeze({ ...review });
  if (
    [value.market, value.seller, value.asset, value.payment].some(
      (address) => !isAddress(address) || address.toLowerCase() === zeroAddress,
    ) ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.requestId) ||
    /^0x0{64}$/.test(value.requestId) ||
    [value.amount, value.opening, value.reserve, value.increment].some(
      (amount) => !uint(amount) || amount === 0n,
    ) ||
    value.reserve < value.opening ||
    [value.starts, value.ends, value.extension].some(
      (time) => !Number.isSafeInteger(time) || time < 0 || time > 2 ** 48 - 1,
    ) ||
    value.starts >= value.ends ||
    value.extension > value.ends - value.starts ||
    typeof value.sourceSlug !== "string" ||
    !value.sourceSlug ||
    typeof value.sourceIdentity !== "string" ||
    !value.sourceIdentity
  )
    refuse("Review valid auction terms before requesting wallet approval.");
  return value;
}

/** Run inside the original transaction callback, after its session gate.
 * Source correspondence and canonical chain reads are observations, not grants.
 * Approval does not require an allowance that it is about to create.
 */
export async function auctionCreationPreflight(
  client: AuctionCreationReader,
  input: AuctionCreationReview,
  phase: "approval" | "creation",
  assertCurrent: () => void,
) {
  const review = snapshot(input);
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => {
    if (expired) refuse("Auction creation checks timed out. Review and retry.");
    assertCurrent();
  };
  try {
    return await Promise.race([
      (async () => {
        current();
        const chainId = await client.getChainId();
        current();
        if (chainId !== 560048)
          refuse("Auction creation requires the configured Hoodi chain.");
        const block = await client.getBlock();
        current();
        if (
          typeof block.number !== "bigint" ||
          block.number < 0n ||
          !block.hash ||
          !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
          /^0x0{64}$/.test(block.hash) ||
          typeof block.timestamp !== "bigint" ||
          block.timestamp < 0n ||
          block.timestamp >= 1n << 48n ||
          BigInt(review.ends) <= block.timestamp
        )
          refuse(
            "The reviewed auction has ended or its source block is unavailable.",
          );
        const [allowedAsset, allowedPayment, paused, balance, allowance] =
          await Promise.all([
            client.readContract({
              address: review.market,
              abi: auctionAbi,
              functionName: "allowedAssetToken",
              args: [review.asset],
              blockNumber: block.number,
            }),
            client.readContract({
              address: review.market,
              abi: auctionAbi,
              functionName: "allowedPaymentToken",
              args: [review.payment],
              blockNumber: block.number,
            }),
            client.readContract({
              address: review.market,
              abi: auctionAbi,
              functionName: "paused",
              blockNumber: block.number,
            }),
            client.readContract({
              address: review.asset,
              abi: auctionTokenAbi,
              functionName: "balanceOf",
              args: [review.seller],
              blockNumber: block.number,
            }),
            client.readContract({
              address: review.asset,
              abi: auctionTokenAbi,
              functionName: "allowance",
              args: [review.seller, review.market],
              blockNumber: block.number,
            }),
          ]);
        current();
        if (
          allowedAsset !== true ||
          allowedPayment !== true ||
          paused !== false ||
          !uint(balance) ||
          balance < review.amount ||
          !uint(allowance) ||
          (phase === "creation" && allowance < review.amount)
        )
          refuse(
            "Current token permission, pause, balance or allowance prevents this auction.",
          );
        await assertRwaTradingEvidence({
          section: "fractional",
          chainId: 560048,
          marketAddress: review.market,
          fractionTokenAddress: review.asset,
          slug: review.sourceSlug,
          identity: review.sourceIdentity,
        });
        current();
        const canonical = await client.getBlock({ blockNumber: block.number });
        current();
        if (
          canonical.number !== block.number ||
          canonical.hash !== block.hash ||
          canonical.timestamp !== block.timestamp
        )
          refuse("The auction source block changed. Review and retry.");
        const finalChain = await client.getChainId();
        current();
        if (finalChain !== 560048)
          refuse("The auction chain changed. Review and retry.");
        return { allowance };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(
            new AuctionCreationCheckError(
              "Auction creation checks timed out. Review and retry.",
            ),
          );
        }, readTimeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof AuctionCreationCheckError) throw error;
    throw new AuctionCreationCheckError(
      "Auction creation checks are unavailable. Review the current wallet and source, then retry.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** The original gate/journal owns authentication and writes. Never carry a
 * simulation across that gate or turn a failed read into transaction authority.
 */
export async function createReviewedAuctionAtWallet<Prepared, Result>(
  client: AuctionCreationReader,
  input: AuctionCreationReview,
  steps: {
    assertCurrent: () => void;
    simulate: (review: AuctionCreationReview) => Promise<Prepared>;
    submit: (prepared: Prepared) => Promise<Result>;
  },
): Promise<Result> {
  const review = snapshot(input);
  await auctionCreationPreflight(
    client,
    review,
    "creation",
    steps.assertCurrent,
  );
  steps.assertCurrent();
  let prepared: Prepared;
  try {
    prepared = await steps.simulate(review);
  } catch {
    throw new AuctionCreationCheckError(
      "Auction simulation is unavailable. No auction creation request was sent.",
    );
  }
  steps.assertCurrent();
  await auctionCreationPreflight(
    client,
    review,
    "creation",
    steps.assertCurrent,
  );
  steps.assertCurrent();
  return steps.submit(prepared);
}
