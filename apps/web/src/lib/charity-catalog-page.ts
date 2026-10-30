import type { Address, Hex, PublicClient } from "viem";
import { isAddress } from "viem";
import { charityEditionsAbi } from "./contracts";
import {
  readCharityEditionFacts,
  charityEditionReadTimeoutMs,
  type CharityEditionFacts,
} from "./charity-edition-facts";

type Reader = Pick<PublicClient, "getChainId" | "getBlock" | "readContract">;
export const charityCatalogPageSize = 20n;
const concurrency = 4;
const unavailable = "Charity edition catalog is unavailable.";
export type CharityCatalogPage = Readonly<{
  start: bigint;
  seriesCount: bigint;
  editionsPerArtwork: bigint;
  unitPriceWei: bigint;
  editions: readonly CharityEditionFacts[];
}>;

function uint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n)
    throw new Error(unavailable);
  return value;
}
function snapshot(block: {
  number: bigint | null;
  hash: Hex | null;
  timestamp: bigint;
}) {
  if (
    typeof block.hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    /^0x0{64}$/i.test(block.hash)
  )
    throw new Error(unavailable);
  const timestamp = uint(block.timestamp);
  if (timestamp >= 1n << 64n) throw new Error(unavailable);
  return {
    number: uint(block.number),
    hash: block.hash.toLowerCase(),
    timestamp,
  };
}

/** One bounded page at one mined block. No series limit, transaction or holder authority is inferred. */
export async function readCharityCatalogPage({
  client,
  contractAddress,
  expectedChainId,
  start = 1n,
  signal,
  isCurrent = () => true,
}: {
  client: Reader;
  contractAddress: Address;
  expectedChainId: number;
  start?: bigint;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<CharityCatalogPage> {
  const address = contractAddress,
    chainId = expectedChainId,
    first = uint(start);
  if (
    !isAddress(address) ||
    /^0x0{40}$/i.test(address) ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    first < 1n ||
    (first - 1n) % charityCatalogPageSize !== 0n
  )
    throw new Error(unavailable);
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const active = () => {
    if (retired || signal?.aborted || !isCurrent())
      throw new Error(unavailable);
  };
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => {
      retired = true;
      reject(new Error(unavailable));
    };
    timer = setTimeout(stop, charityEditionReadTimeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        active();
        if ((await client.getChainId()) !== chainId)
          throw new Error(unavailable);
        active();
        const block = snapshot(await client.getBlock({ blockTag: "latest" }));
        active();
        const contract = {
          abi: charityEditionsAbi,
          address,
          blockNumber: block.number,
        };
        const values = await Promise.all([
          client.readContract({ ...contract, functionName: "seriesCount" }),
          client.readContract({
            ...contract,
            functionName: "EDITIONS_PER_ARTWORK",
          }),
          client.readContract({
            ...contract,
            functionName: "PRIMARY_PRICE_WEI",
          }),
        ]);
        active();
        const seriesCount = uint(values[0]),
          editionsPerArtwork = uint(values[1]),
          unitPriceWei = uint(values[2]);
        if (
          editionsPerArtwork !== 100n ||
          unitPriceWei !== 10n ** 16n ||
          (seriesCount === 0n ? first !== 1n : first > seriesCount)
        )
          throw new Error(unavailable);
        const remaining = seriesCount === 0n ? 0n : seriesCount - first + 1n;
        // Convert only a page-bounded count; never allocate from an untrusted uint256 seriesCount.
        const length = Number(
          remaining < charityCatalogPageSize
            ? remaining
            : charityCatalogPageSize,
        );
        const editions: CharityEditionFacts[] = new Array(length);
        // The detail reader keeps its complete validation and reorg/chain checks. Its initial
        // block read is narrowed to this page's already captured block, not a later "latest".
        const fixedClient: Reader = {
          getChainId: client.getChainId.bind(client),
          readContract: client.readContract.bind(client),
          getBlock: (async (parameters: Parameters<Reader["getBlock"]>[0]) => {
            active();
            const result = await client.getBlock(
              parameters?.blockTag === "latest"
                ? { blockNumber: block.number }
                : parameters,
            );
            active();
            const observed = snapshot(result);
            if (
              observed.number !== block.number ||
              observed.hash !== block.hash ||
              observed.timestamp !== block.timestamp
            )
              throw new Error(unavailable);
            return { ...result };
          }) as Reader["getBlock"],
        };
        let next = 0;
        const worker = async () => {
          while (next < length) {
            active();
            const index = next++;
            const facts = await readCharityEditionFacts({
              client: fixedClient,
              contractAddress: address,
              expectedChainId: chainId,
              tokenId: (first + BigInt(index)).toString(),
              signal,
              isCurrent: () => !retired && !signal?.aborted && isCurrent(),
            });
            active();
            if (
              facts.unitPriceWei !== unitPriceWei ||
              facts.mintedUnits !== editionsPerArtwork
            )
              throw new Error(unavailable);
            editions[index] = facts;
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(concurrency, length) }, worker),
        );
        active();
        const final = snapshot(
          await client.getBlock({ blockNumber: block.number }),
        );
        active();
        if (
          final.number !== block.number ||
          final.hash !== block.hash ||
          final.timestamp !== block.timestamp
        )
          throw new Error(unavailable);
        if ((await client.getChainId()) !== chainId)
          throw new Error(unavailable);
        active();
        return Object.freeze({
          start: first,
          seriesCount,
          editionsPerArtwork,
          unitPriceWei,
          editions: Object.freeze(editions),
        });
      }),
      interrupted,
    ]);
  } finally {
    retired = true;
    clearTimeout(timer);
    if (stop) signal?.removeEventListener("abort", stop);
  }
}
