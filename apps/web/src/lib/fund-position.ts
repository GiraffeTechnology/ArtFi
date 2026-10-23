import type { FractionalCatalogRecord } from "@giraffetechnology/artfi-api-client";
import {
  type Address,
  type PublicClient,
  encodeAbiParameters,
  keccak256,
  parseAbi,
} from "viem";

const factoryAbi = parseAbi([
  "function vaultByAsset(bytes32) view returns (address)",
]);
const vaultAbi = parseAbi([
  "function collection() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function fractionalToken() view returns (address)",
  "function fractionalSupply() view returns (uint256)",
  "function deposited() view returns (bool)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const nftAbi = parseAbi(["function ownerOf(uint256) view returns (address)"]);

export type FundPosition = {
  issuance: FractionalCatalogRecord;
  balance: bigint;
  supply: bigint;
  nftHeldByVault: boolean;
};

/** Read-only: immutable fund links and balance share one finalized block. */
export async function readFundPosition(
  client: PublicClient,
  factory: Address,
  account: Address,
  item: FractionalCatalogRecord,
  blockNumber: bigint,
): Promise<FundPosition> {
  if (BigInt(item.blockNumber) > blockNumber)
    throw new Error("ISSUANCE_NOT_FINALIZED");
  const vault = item.vaultAddress as Address;
  const token = item.fractionTokenAddress as Address;
  const collection = item.collectionAddress as Address;
  const tokenId = BigInt(item.tokenId);
  const key = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [collection, tokenId],
    ),
  );
  const [
    origin,
    registeredVault,
    actualCollection,
    actualTokenId,
    actualToken,
    supply,
    deposited,
    balance,
    totalSupply,
    decimals,
    owner,
  ] = await Promise.all([
    client.getBlock({ blockNumber: BigInt(item.blockNumber) }),
    client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "vaultByAsset",
      args: [key],
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "collection",
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "tokenId",
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "fractionalToken",
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "fractionalSupply",
      blockNumber,
    }),
    client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposited",
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account],
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "totalSupply",
      blockNumber,
    }),
    client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "decimals",
      blockNumber,
    }),
    client.readContract({
      address: collection,
      abi: nftAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber,
    }),
  ]);
  if (
    origin.hash?.toLowerCase() !== item.blockHash ||
    registeredVault.toLowerCase() !== vault ||
    actualCollection.toLowerCase() !== collection ||
    actualTokenId !== tokenId ||
    actualToken.toLowerCase() !== token ||
    supply !== BigInt(item.supply) ||
    totalSupply !== supply ||
    supply === 0n ||
    balance > supply ||
    decimals !== 18
  ) {
    throw new Error("FUND_IDENTITY_OR_SUPPLY_MISMATCH");
  }
  return {
    issuance: item,
    balance,
    supply,
    nftHeldByVault: deposited && owner.toLowerCase() === vault,
  };
}

export function fundSharePercent(balance: bigint, supply: bigint): string {
  // Floor to four decimal places; no floating-point rounding or valuation.
  const scaled = (balance * 1_000_000n) / supply;
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`;
}
