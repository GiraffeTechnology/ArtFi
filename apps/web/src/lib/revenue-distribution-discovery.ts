import type { Address, PublicClient } from "viem";
import {
  revenueAddress,
  revenueDistributorAbi,
  type RevenueBinding,
} from "./revenue-claims";

const maximumUint256 = (1n << 256n) - 1n;
export type RevenueDistributionInventory = Readonly<
  RevenueBinding & {
    count: bigint;
    blockNumber: bigint;
    blockHash: string;
  }
>;

/** Discovery proves only a configured distributor's current ID range. It
 * creates no entitlement, reservation or authority to claim. */
export async function readRevenueDistributionInventory(
  client: PublicClient,
  input: RevenueBinding,
): Promise<RevenueDistributionInventory> {
  const binding = Object.freeze({
    distributor: input.distributor,
    fractionToken: input.fractionToken,
    account: input.account,
  });
  if (
    ![binding.distributor, binding.fractionToken, binding.account].every(
      (value) => revenueAddress(value),
    )
  )
    throw new Error("Invalid revenue discovery binding.");
  if ((await client.getChainId()) !== 560048)
    throw new Error("Revenue discovery requires Hoodi.");
  const block = await client.getBlock();
  const blockNumber = block.number,
    blockHash = block.hash;
  if (
    typeof blockNumber !== "bigint" ||
    blockNumber < 0n ||
    typeof blockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(blockHash)
  )
    throw new Error("A mined distribution observation is unavailable.");
  const base = {
    address: binding.distributor,
    abi: revenueDistributorAbi,
    blockNumber,
  };
  const [code, tokenCode, token, count] = await Promise.all([
    client.getCode({ address: binding.distributor, blockNumber }),
    client.getCode({ address: binding.fractionToken, blockNumber }),
    client.readContract({ ...base, functionName: "fractionToken" }),
    client.readContract({ ...base, functionName: "distributionCount" }),
  ]);
  if (
    !code ||
    code === "0x" ||
    !tokenCode ||
    tokenCode === "0x" ||
    typeof token !== "string" ||
    token.toLowerCase() !== binding.fractionToken.toLowerCase() ||
    typeof count !== "bigint" ||
    count < 0n ||
    count > maximumUint256
  )
    throw new Error(
      "The distribution inventory does not match the configured token.",
    );
  const [canonical, chain] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getChainId(),
  ]);
  if (
    chain !== 560048 ||
    canonical.number !== blockNumber ||
    canonical.hash !== blockHash
  )
    throw new Error("The distribution inventory changed. Read it again.");
  return Object.freeze({ ...binding, count, blockNumber, blockHash });
}

export function revenueDistributionIds(
  inventory: RevenueDistributionInventory,
  requestedOffset: bigint,
) {
  if (
    inventory.count < 0n ||
    inventory.count > maximumUint256 ||
    requestedOffset < 0n ||
    requestedOffset > maximumUint256
  )
    throw new Error("Invalid distribution page.");
  const size = 10n;
  const lastOffset =
    inventory.count === 0n ? 0n : ((inventory.count - 1n) / size) * size;
  const offset =
    requestedOffset > lastOffset ? lastOffset : (requestedOffset / size) * size;
  const ids: bigint[] = [];
  for (let i = 0n; i < size && offset + i < inventory.count; i++)
    ids.push(inventory.count - offset - i);
  return Object.freeze({
    ids: Object.freeze(ids),
    offset,
    newer: offset > 0n,
    older: offset + BigInt(ids.length) < inventory.count,
  });
}
