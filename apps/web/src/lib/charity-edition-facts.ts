import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { charityEditionsAbi } from "./contracts";

type Reader = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;
export type CharityEditionFacts = Readonly<{
  tokenId: string;
  artworkId: Hex;
  metadataHash: Hex;
  distributionWallet: Address;
  createdAt: number;
  soldOutAt: number;
  physicalDonationRecordedAt: number;
  mintedUnits: bigint;
  distributorUnits: bigint;
  unitPriceWei: bigint;
}>;

export const charityEditionReadTimeoutMs = 8000;
const unavailable = "Charity edition facts are unavailable.";
const hash32 = (value: unknown): value is Hex =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{64}$/.test(value) &&
  !/^0x0{64}$/i.test(value);
function uint(value: unknown, bits = 256): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bits))
    throw new Error(unavailable);
  return value;
}
function seconds(value: unknown): bigint {
  const result = uint(value, 64);
  // Keep valid uint64 chain observations outside JavaScript Date's range out of render.
  if (result > 8640000000000n) throw new Error(unavailable);
  return result;
}
function mined(block: {
  number: bigint | null;
  hash: Hex | null;
  timestamp: bigint;
}) {
  if (!hash32(block.hash)) throw new Error(unavailable);
  return {
    number: uint(block.number),
    hash: block.hash,
    timestamp: uint(block.timestamp, 64),
  };
}

/** One bounded, read-only block observation. It proves neither finality nor holder access. */
export async function readCharityEditionFacts({
  client,
  contractAddress,
  tokenId,
  expectedChainId,
  signal,
  isCurrent = () => true,
}: {
  client: Reader;
  contractAddress: Address;
  tokenId: string;
  expectedChainId: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<CharityEditionFacts> {
  // Capture caller primitives before the first provider wait.
  const address = contractAddress,
    requestedId = tokenId,
    chainId = expectedChainId;
  if (
    !isAddress(address) ||
    /^0x0{40}$/i.test(address) ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !/^[0-9]{1,78}$/.test(requestedId)
  )
    throw new Error(unavailable);
  const id = uint(BigInt(requestedId));
  if (id === 0n) throw new Error(unavailable);
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const active = () => {
    if (retired || signal?.aborted || !isCurrent())
      throw new Error(unavailable);
  };
  const interrupted = new Promise<never>((_, reject) => {
    const stop = () => {
      retired = true;
      reject(new Error(unavailable));
    };
    timer = setTimeout(stop, charityEditionReadTimeoutMs);
    onAbort = stop;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) stop();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        active();
        if ((await client.getChainId()) !== chainId)
          throw new Error(unavailable);
        active();
        const snapshot = mined(await client.getBlock({ blockTag: "latest" }));
        active();
        const contract = {
          abi: charityEditionsAbi,
          address,
          blockNumber: snapshot.number,
        };
        const raw: unknown = await client.readContract({
          ...contract,
          functionName: "series",
          args: [id],
        });
        active();
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error(unavailable);
        const record = raw as Record<string, unknown>;
        // Do not retain the provider-owned series object across the following awaits.
        const artworkId = record.artworkId,
          metadataHash = record.metadataHash,
          distributionWallet = record.distributionWallet,
          createdAt = seconds(record.createdAt),
          soldOutAt = seconds(record.soldOutAt),
          physicalDonationRecordedAt = seconds(
            record.physicalDonationRecordedAt,
          );
        if (
          !hash32(artworkId) ||
          !hash32(metadataHash) ||
          typeof distributionWallet !== "string" ||
          !isAddress(distributionWallet) ||
          /^0x0{40}$/i.test(distributionWallet) ||
          createdAt === 0n ||
          createdAt > snapshot.timestamp ||
          soldOutAt > snapshot.timestamp ||
          physicalDonationRecordedAt > snapshot.timestamp ||
          (soldOutAt !== 0n && soldOutAt < createdAt) ||
          (physicalDonationRecordedAt !== 0n &&
            (soldOutAt === 0n || physicalDonationRecordedAt < soldOutAt))
        )
          throw new Error(unavailable);
        active();
        const observed = await Promise.all([
          client.readContract({
            ...contract,
            functionName: "totalSupply",
            args: [id],
          }),
          client.readContract({
            ...contract,
            functionName: "balanceOf",
            args: [distributionWallet, id],
          }),
          client.readContract({
            ...contract,
            functionName: "PRIMARY_PRICE_WEI",
          }),
        ]);
        active();
        const mintedUnits = uint(observed[0]),
          distributorUnits = uint(observed[1]),
          unitPriceWei = uint(observed[2]);
        // Existing immutable contract and CH.1/CH.2: 100 units, recorded 0.01 ETH price.
        if (
          mintedUnits !== 100n ||
          distributorUnits > mintedUnits ||
          unitPriceWei !== 10n ** 16n
        )
          throw new Error(unavailable);
        const canonical = mined(
          await client.getBlock({ blockNumber: snapshot.number }),
        );
        active();
        if (
          canonical.number !== snapshot.number ||
          canonical.hash.toLowerCase() !== snapshot.hash.toLowerCase() ||
          canonical.timestamp !== snapshot.timestamp
        )
          throw new Error(unavailable);
        if ((await client.getChainId()) !== chainId)
          throw new Error(unavailable);
        active();
        return Object.freeze({
          tokenId: id.toString(),
          artworkId,
          metadataHash,
          distributionWallet,
          createdAt: Number(createdAt),
          soldOutAt: Number(soldOutAt),
          physicalDonationRecordedAt: Number(physicalDonationRecordedAt),
          mintedUnits,
          distributorUnits,
          unitPriceWei,
        });
      }),
      interrupted,
    ]);
  } finally {
    retired = true;
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
