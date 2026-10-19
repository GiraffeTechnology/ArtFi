import { isAddress, zeroHash, type Hash, type PublicClient } from "viem";

export type MarketReceiptClient = Pick<
  PublicClient,
  "getChainId" | "getTransaction" | "getBlock" | "waitForTransactionReceipt"
>;
export const marketReceiptReadTimeoutMs = 15000;
type Outcome = Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
const validHash = (value: unknown): value is Hash =>
  typeof value === "string" &&
  /^0x[\da-f]{64}$/i.test(value) &&
  value.toLowerCase() !== zeroHash;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Read-only reconciliation of the original Hoodi broadcast; ambiguity retains the journal. */
export async function verifyMarketReceipt(
  client: MarketReceiptClient,
  originalHash: Hash,
) {
  let retired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => {
    if (retired) throw new Error("Retired receipt read");
  };
  const work = async () => {
    if (!validHash(originalHash) || (await client.getChainId()) !== 560048)
      throw new Error("Invalid original chain/hash");
    active();
    const original = await client.getTransaction({ hash: originalHash });
    active();
    if (
      !validHash(original.hash) ||
      !same(original.hash, originalHash) ||
      !isAddress(original.from) ||
      !original.to ||
      !isAddress(original.to) ||
      !/^0x(?:[\da-f]{2})*$/i.test(original.input) ||
      typeof original.value !== "bigint" ||
      original.value < 0n ||
      !Number.isSafeInteger(original.nonce) ||
      original.nonce < 0 ||
      (original.chainId !== undefined && original.chainId !== 560048)
    )
      throw new Error("Invalid original transaction");
    let expected = originalHash;
    let reason: "repriced" | "replaced" | "cancelled" | undefined;
    const receipt: Outcome = await client.waitForTransactionReceipt({
      hash: originalHash,
      onReplaced(value) {
        // A timed-out read cannot replace another screen's retained hash.
        if (retired) return;
        const next = value.transactionReceipt.transactionHash;
        if (
          !validHash(next) ||
          !["repriced", "replaced", "cancelled"].includes(value.reason)
        )
          throw new Error("Invalid replacement");
        expected = next;
        reason = value.reason;
      },
    });
    active();
    if (
      (reason && same(expected, originalHash)) ||
      !validHash(receipt.transactionHash) ||
      !same(receipt.transactionHash, expected) ||
      !validHash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" ||
      receipt.blockNumber < 0n ||
      !Array.isArray(receipt.logs) ||
      receipt.logs.some((log) => log.removed) ||
      !["success", "reverted"].includes(receipt.status)
    )
      throw new Error("Unproven receipt outcome");
    const canonical = async () => {
      const [chain, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      active();
      if (
        chain !== 560048 ||
        block.number !== receipt.blockNumber ||
        !validHash(block.hash) ||
        !same(block.hash, receipt.blockHash)
      )
        throw new Error("Noncanonical receipt");
    };
    await canonical();
    const settled = await client.getTransaction({ hash: expected });
    active();
    if (
      !validHash(settled.hash) ||
      !same(settled.hash, expected) ||
      !same(settled.from, original.from) ||
      settled.nonce !== original.nonce ||
      (settled.chainId !== undefined && settled.chainId !== 560048) ||
      settled.blockNumber !== receipt.blockNumber ||
      !validHash(settled.blockHash) ||
      !same(settled.blockHash, receipt.blockHash)
    )
      throw new Error("Unproven original nonce consumption");
    if (
      reason !== "cancelled" &&
      reason !== "replaced" &&
      (!settled.to ||
        !same(settled.to, original.to) ||
        !same(settled.input, original.input) ||
        settled.value !== original.value)
    )
      throw new Error("Changed original call");
    await canonical();
    active();
    return { receipt, reason, expected };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          retired = true;
          reject(new Error("Receipt read deadline"));
        }, marketReceiptReadTimeoutMs);
      }),
    ]);
  } finally {
    retired = true;
    clearTimeout(timer);
  }
}
