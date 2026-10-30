// Deterministic TEST_ONLY chain evidence. No RPC, wallet, signatures or network.
import type { Hash, TransactionReceipt } from "viem";
import type { MarketReceiptClient } from "./market-canonical-receipt";
export const testBlockHash = `0x${"ab".repeat(32)}` as Hash;
export function testReceipt(
  transactionHash: Hash,
  status: "success" | "reverted" = "success",
) {
  return {
    transactionHash,
    status,
    blockHash: testBlockHash,
    blockNumber: 12n,
    logs: [],
  } as unknown as TransactionReceipt;
}
export function testTransaction(hash: Hash) {
  return {
    hash,
    chainId: 560048,
    from: "0x1000000000000000000000000000000000000001",
    to: "0x2000000000000000000000000000000000000002",
    input: "0x1234",
    value: 0n,
    nonce: 7,
    blockHash: testBlockHash,
    blockNumber: 12n,
  };
}
export function testReceiptClient(wait: unknown): MarketReceiptClient {
  return {
    waitForTransactionReceipt: wait,
    getChainId: async () => 560048,
    getTransaction: async ({ hash }: { hash: Hash }) => testTransaction(hash),
    getBlock: async () => ({ hash: testBlockHash, number: 12n }),
  } as unknown as MarketReceiptClient;
}
