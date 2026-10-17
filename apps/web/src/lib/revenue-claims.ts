import {
  isAddress,
  zeroAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

export const revenueDistributorAbi = parseAbi([
  "function fractionToken() view returns (address)",
  "function distributionCount() view returns (uint256)",
  "function distributions(uint256) view returns (address payoutToken,uint256 revenueAmount,uint256 snapshotSupply,uint48 snapshotTimepoint)",
  "function claimed(uint256,address) view returns (bool)",
  "function claimable(uint256,address) view returns (uint256)",
  "function totalClaimed(uint256) view returns (uint256)",
  "function claim(uint256) returns (uint256)",
]);
const historicalAbi = parseAbi([
  "function clock() view returns (uint48)",
  "function getPastBalance(address,uint256) view returns (uint256)",
  "function getPastTotalSupply(uint256) view returns (uint256)",
]);
const maxUint = (1n << 256n) - 1n;
export function revenueAddress(value: string | undefined): Address | undefined {
  return value &&
    isAddress(value, { strict: false }) &&
    value.toLowerCase() !== zeroAddress
    ? (value as Address)
    : undefined;
}
export function revenueRoundId(value: string) {
  if (!/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > maxUint)
    throw new Error("Enter a positive decimal uint256 distribution ID.");
  return BigInt(value);
}
const uint = (value: unknown): bigint => {
  if (typeof value !== "bigint" || value < 0n || value > maxUint)
    throw new Error("Invalid revenue contract response.");
  return value;
};
export type RevenueBinding = {
  distributor: Address;
  fractionToken: Address;
  account: Address;
};
export type RevenueRound = RevenueBinding & {
  id: bigint;
  count: bigint;
  payoutToken: Address;
  revenueAmount: bigint;
  snapshotSupply: bigint;
  snapshotTimepoint: number;
  snapshotBalance: bigint;
  claimed: boolean;
  totalClaimed: bigint;
  claimable: bigint;
  blockNumber: bigint;
  blockHash: string;
  observedAt: number;
};
export async function readRevenueRound(
  client: PublicClient,
  binding: RevenueBinding,
  id: bigint,
): Promise<RevenueRound> {
  if (
    ![binding.distributor, binding.fractionToken, binding.account].every(
      (value) => revenueAddress(value),
    ) ||
    id <= 0n ||
    id > maxUint
  )
    throw new Error("Invalid revenue binding.");
  if ((await client.getChainId()) !== 560048)
    throw new Error("Revenue claims require Hoodi.");
  const block = await client.getBlock();
  if (
    block.number === null ||
    !block.hash ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
  )
    throw new Error("A canonical observation block is unavailable.");
  const blockNumber = block.number;
  const base = {
    address: binding.distributor,
    abi: revenueDistributorAbi,
    blockNumber,
  };
  const [
    code,
    tokenCode,
    fractionToken,
    count,
    round,
    claimed,
    claimable,
    totalClaimed,
  ] = await Promise.all([
    client.getCode({ address: binding.distributor, blockNumber }),
    client.getCode({ address: binding.fractionToken, blockNumber }),
    client.readContract({ ...base, functionName: "fractionToken" }),
    client.readContract({ ...base, functionName: "distributionCount" }),
    client.readContract({ ...base, functionName: "distributions", args: [id] }),
    client.readContract({
      ...base,
      functionName: "claimed",
      args: [id, binding.account],
    }),
    client.readContract({
      ...base,
      functionName: "claimable",
      args: [id, binding.account],
    }),
    client.readContract({ ...base, functionName: "totalClaimed", args: [id] }),
  ]);
  if (
    !code ||
    code === "0x" ||
    !tokenCode ||
    tokenCode === "0x" ||
    typeof fractionToken !== "string" ||
    fractionToken.toLowerCase() !== binding.fractionToken.toLowerCase() ||
    uint(count) < id ||
    !Array.isArray(round) ||
    round.length !== 4 ||
    typeof claimed !== "boolean"
  )
    throw new Error(
      "The distributor does not match the configured fraction token or round.",
    );
  const payoutToken = revenueAddress(round[0]);
  const revenueAmount = uint(round[1]),
    snapshotSupply = uint(round[2]),
    snapshotTimepoint = round[3];
  if (
    !payoutToken ||
    revenueAmount === 0n ||
    snapshotSupply === 0n ||
    !Number.isSafeInteger(snapshotTimepoint) ||
    snapshotTimepoint < 0 ||
    snapshotTimepoint >= 2 ** 48 ||
    uint(totalClaimed) > revenueAmount
  )
    throw new Error("Invalid funded distribution.");
  const tokenBase = {
    address: binding.fractionToken,
    abi: historicalAbi,
    blockNumber,
  };
  const [clock, balance, supply] = await Promise.all([
    client.readContract({ ...tokenBase, functionName: "clock" }),
    client.readContract({
      ...tokenBase,
      functionName: "getPastBalance",
      args: [binding.account, BigInt(snapshotTimepoint)],
    }),
    client.readContract({
      ...tokenBase,
      functionName: "getPastTotalSupply",
      args: [BigInt(snapshotTimepoint)],
    }),
  ]);
  if (
    !Number.isSafeInteger(clock) ||
    clock <= snapshotTimepoint ||
    uint(supply) !== snapshotSupply ||
    uint(balance) > snapshotSupply ||
    uint(claimable) > revenueAmount - totalClaimed ||
    uint(claimable) !==
      (claimed ? 0n : (revenueAmount * balance) / snapshotSupply)
  )
    throw new Error("Historical snapshot and claimable evidence disagree.");
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== block.hash || (await client.getChainId()) !== 560048)
    throw new Error("The revenue observation changed. Read the round again.");
  return {
    ...binding,
    id,
    count,
    payoutToken,
    revenueAmount,
    snapshotSupply,
    snapshotTimepoint,
    snapshotBalance: balance,
    claimed,
    totalClaimed,
    claimable,
    blockNumber,
    blockHash: block.hash,
    observedAt: Date.now(),
  };
}
export function assertReviewedRevenue(
  reviewed: RevenueRound,
  fresh: RevenueRound,
) {
  if (
    reviewed.id !== fresh.id ||
    ["distributor", "fractionToken", "account", "payoutToken"].some(
      (key) =>
        reviewed[key as keyof RevenueBinding | "payoutToken"].toLowerCase() !==
        fresh[key as keyof RevenueBinding | "payoutToken"].toLowerCase(),
    ) ||
    reviewed.revenueAmount !== fresh.revenueAmount ||
    reviewed.snapshotSupply !== fresh.snapshotSupply ||
    reviewed.snapshotTimepoint !== fresh.snapshotTimepoint ||
    reviewed.snapshotBalance !== fresh.snapshotBalance ||
    reviewed.claimable !== fresh.claimable ||
    fresh.claimed ||
    fresh.claimable === 0n
  )
    throw new Error(
      "The reviewed distribution changed or has no available claim. Read it again.",
    );
}
export async function revenueReadDeadline<T>(
  read: () => Promise<T>,
  ms = 12000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Revenue reads timed out. No wallet action was requested.",
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
