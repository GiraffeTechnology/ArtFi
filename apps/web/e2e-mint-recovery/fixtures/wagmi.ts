// TEST_ONLY registry reads. Never connects to a wallet or RPC provider.
import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
export const wallet = "0x1000000000000000000000000000000000000010" as const;
export const registry = "0x1000000000000000000000000000000000000001" as const;
export const collection = "0x1000000000000000000000000000000000000002" as const;
export const intent = {
  intentId: "intent-test",
  requestId: `0x${"1".repeat(64)}` as const,
  recipient: wallet,
  registryAddress: registry,
  chainId: 560048,
  metadataUri: "ipfs://TEST_ONLY-metadata",
  metadataSha256: `0x${"2".repeat(64)}` as const,
  status: "prepared",
};
const hash = `0x${"7".repeat(64)}` as const;
export const fixture = {
  mode: new URL(location.href).searchParams.get("mode") ?? "normal",
  sign: 0,
  write: 0,
  reads: [] as { method: string; block: string }[],
  blocks: 0,
};
export const client = {
  getChainId: async () =>
    fixture.mode === "wrong-chain" ||
    (fixture.mode === "chain-flip" && fixture.reads.length > 0)
      ? 1
      : 560048,
  getBlock: async () => {
    fixture.blocks++;
    if (fixture.mode === "unavailable")
      throw Error("TEST_ONLY block unavailable");
    return {
      number: fixture.mode === "unmined" ? null : 100n,
      hash:
        fixture.mode === "zero-hash"
          ? `0x${"0".repeat(64)}`
          : fixture.mode === "reorg" && fixture.blocks % 2 === 0
            ? `0x${"8".repeat(64)}`
            : hash,
    };
  },
  readContract: async ({
    functionName,
    blockNumber,
  }: {
    functionName: string;
    blockNumber: bigint;
  }) => {
    fixture.reads.push({ method: functionName, block: String(blockNumber) });
    if (functionName === "nft") return collection;
    if (functionName !== "assetByRequest")
      throw Error("Unexpected TEST_ONLY read");
    return {
      creator: wallet,
      recipient: wallet,
      tokenId: 7n,
      metadataHash: intent.metadataSha256,
      metadataURI: intent.metadataUri,
      intentHash: keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
          [wallet, intent.metadataUri, intent.metadataSha256],
        ),
      ),
      createdAt: 1n,
    };
  },
} as unknown as PublicClient;
export function useAccount() {
  return { address: wallet, isConnected: true };
}
export function useChainId() {
  return 560048;
}
export function usePublicClient() {
  return client;
}
export function useReadContract() {
  return { data: undefined };
}
export function useSignMessage() {
  return {
    signMessageAsync: async () => {
      fixture.sign++;
      throw Error("Unexpected TEST_ONLY signature");
    },
  };
}
export function useWriteContract() {
  return {
    writeContractAsync: async () => {
      fixture.write++;
      throw Error("Unexpected TEST_ONLY mint");
    },
  };
}
