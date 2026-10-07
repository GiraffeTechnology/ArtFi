import type { PublicClient } from "viem";
import { artFiFractionMarketAbi, wholeArtworkMarketAbi } from "./contracts";
import { decodeNativeOrder, type NativeOrder } from "./native-order";

export type NativeOrderState = {
  label: string;
  remaining?: string;
  blockNumber: string;
};

/** The order store records terms. Only current chain state says whether any authority remains. */
export async function readNativeOrderState(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  order: NativeOrder,
): Promise<NativeOrderState> {
  const decoded = decodeNativeOrder(order);
  if ((await client.getChainId()) !== order.chainId)
    throw new Error("Wrong reader chain.");
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null)
    throw new Error("The latest mined block is unavailable.");
  const blockNumber = block.number.toString();
  const epoch = await client.readContract({
    address: order.marketAddress,
    abi: wholeArtworkMarketAbi,
    functionName: "sellerEpoch",
    args: [decoded.intent.seller],
    blockNumber: block.number,
  });
  if (epoch !== decoded.intent.epoch)
    return { label: "Withdrawn by seller epoch", blockNumber, remaining: "0" };
  if (decoded.kind === "whole") {
    const used = await client.readContract({
      address: order.marketAddress,
      abi: wholeArtworkMarketAbi,
      functionName: "intentUsed",
      args: [order.intentHash],
      blockNumber: block.number,
    });
    if (used)
      return { label: "Settled or withdrawn", blockNumber, remaining: "0" };
  } else {
    const filled = await client.readContract({
      address: order.marketAddress,
      abi: artFiFractionMarketAbi,
      functionName: "intentFilled",
      args: [order.intentHash],
      blockNumber: block.number,
    });
    const remaining =
      filled >= decoded.intent.maxAmount
        ? 0n
        : decoded.intent.maxAmount - filled;
    if (remaining === 0n)
      return {
        label: "No remaining authorization",
        remaining: "0",
        blockNumber,
      };
    if (block.timestamp >= BigInt(decoded.intent.endsAt))
      return { label: "Expired", remaining: remaining.toString(), blockNumber };
    if (block.timestamp < BigInt(decoded.intent.startsAt))
      return {
        label: "Not open yet",
        remaining: remaining.toString(),
        blockNumber,
      };
    return {
      label: filled > 0n ? "Partially filled" : "Open authorization",
      remaining: remaining.toString(),
      blockNumber,
    };
  }
  return {
    label:
      block.timestamp >= BigInt(decoded.intent.endsAt)
        ? "Expired"
        : block.timestamp < BigInt(decoded.intent.startsAt)
          ? "Not open yet"
          : "Open authorization",
    remaining: "1",
    blockNumber,
  };
}
