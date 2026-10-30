import {
  isAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import type { DaoTransaction } from "./dao-action-state";

export const daoReceiptReadTimeoutMs = 15000;
export type DaoReceiptBinding = {
  chainId: 560048;
  account: Address;
  targets: readonly Address[];
};
type Reader = Pick<
  PublicClient,
  "getChainId" | "getTransaction" | "getBlock" | "waitForTransactionReceipt"
>;
const hash = (value: unknown): value is Hash =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{64}$/.test(value) &&
  value.toLowerCase() !== zeroHash;
const address = (value: unknown): value is Address =>
  typeof value === "string" &&
  isAddress(value) &&
  value.toLowerCase() !== zeroAddress;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
class DaoReceiptVerificationError extends Error {}
function fail(message: string): never {
  throw new DaoReceiptVerificationError(message);
}

/** Confirmation is read-only. Pending authority is freed only by an exact canonical outcome. */
export async function checkDaoTransaction({
  client,
  transaction,
  binding,
  isCurrent,
  update,
  onHash,
}: {
  client: Reader;
  transaction: DaoTransaction;
  binding: DaoReceiptBinding;
  isCurrent: () => boolean;
  update: (transaction: DaoTransaction) => void;
  onHash?: (hash: Hash) => void;
}): Promise<DaoTransaction> {
  let current: DaoTransaction = {
    ...transaction,
    phase: "pending",
    error: undefined,
  };
  let retired = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => {
    if (retired || !isCurrent())
      fail(
        "The DAO receipt context changed. The original request remains unresolved.",
      );
  };
  const publish = () => {
    if (!retired && isCurrent()) update(current);
  };
  publish();
  const work = async (): Promise<DaoTransaction> => {
    active();
    if (
      !hash(transaction.hash) ||
      binding.chainId !== 560048 ||
      !address(binding.account) ||
      binding.targets.length < 1 ||
      binding.targets.length > 2 ||
      !binding.targets.every(address)
    )
      fail("The original DAO transaction bindings are invalid.");
    if ((await client.getChainId()) !== binding.chainId)
      fail("The DAO receipt reader is not on Hoodi.");
    active();
    const original = await client.getTransaction({ hash: transaction.hash });
    active();
    if (
      !hash(original.hash) ||
      !same(original.hash, transaction.hash) ||
      original.chainId !== binding.chainId ||
      !address(original.from) ||
      !same(original.from, binding.account) ||
      !original.to ||
      !binding.targets.some((t) => same(t, original.to!)) ||
      original.value !== 0n ||
      !Number.isSafeInteger(original.nonce) ||
      original.nonce < 0
    )
      fail(
        "The original DAO transaction does not match its account, chain and deployment.",
      );
    if (
      transaction.request &&
      (!same(original.to, transaction.request.target) ||
        !same(original.input, transaction.request.input) ||
        original.value.toString() !== transaction.request.value)
    )
      fail("The DAO transaction changed the reviewed target, input or value.");
    let expected = transaction.hash,
      reason: "repriced" | "replaced" | "cancelled" | undefined;
    const receipt = await client.waitForTransactionReceipt({
      hash: transaction.hash,
      onReplaced(value) {
        active();
        const next = value.transactionReceipt.transactionHash;
        if (!hash(next))
          fail("The replacement DAO transaction hash is invalid.");
        expected = next;
        reason = value.reason;
      },
    });
    active();
    if (
      (reason && same(expected, transaction.hash)) ||
      !hash(receipt.transactionHash) ||
      !same(receipt.transactionHash, expected) ||
      !hash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" ||
      receipt.blockNumber < 0n ||
      receipt.logs.some((log) => log.removed)
    )
      fail(
        "The DAO receipt does not match the original request and mined block.",
      );
    const canonical = async () => {
      const [chain, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      active();
      if (
        chain !== binding.chainId ||
        block.number !== receipt.blockNumber ||
        !block.hash ||
        !same(block.hash, receipt.blockHash)
      )
        fail(
          "The DAO receipt block or chain changed. The original request remains unresolved.",
        );
    };
    await canonical();
    const settled = await client.getTransaction({ hash: expected });
    active();
    if (
      !hash(settled.hash) ||
      !same(settled.hash, expected) ||
      settled.chainId !== binding.chainId ||
      !same(settled.from, binding.account) ||
      settled.nonce !== original.nonce
    )
      fail(
        "The DAO replacement does not consume the original account and nonce.",
      );
    if (
      reason !== "cancelled" &&
      reason !== "replaced" &&
      (!settled.to ||
        !same(settled.to, original.to) ||
        !same(settled.input, original.input) ||
        settled.value !== original.value)
    )
      fail("The settled DAO transaction changed the original call.");
    await canonical();
    active();
    const proof = {
      originalHash: transaction.hash,
      transactionHash: expected,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      chainId: binding.chainId,
    };
    if (reason === "cancelled" || reason === "replaced")
      return {
        ...current,
        phase: "failed",
        receipt: proof,
        error:
          "The original DAO transaction was cancelled or replaced in a confirmed canonical block. Review its result before another action.",
      };
    if (receipt.status !== "success" && receipt.status !== "reverted")
      fail("The DAO receipt outcome remains unresolved.");
    if (reason === "repriced") {
      active();
      onHash?.(expected);
      current = { ...current, hash: expected };
    }
    return {
      ...current,
      phase: receipt.status === "success" ? "confirmed" : "failed",
      receipt: proof,
      error:
        receipt.status === "reverted"
          ? "The DAO transaction reverted in a confirmed canonical block."
          : undefined,
    };
  };
  try {
    current = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          retired = true;
          reject(
            new DaoReceiptVerificationError(
              "The DAO receipt check timed out. Its original request remains unresolved.",
            ),
          );
        }, daoReceiptReadTimeoutMs);
      }),
    ]);
  } catch (error) {
    current = {
      ...current,
      phase: "unknown",
      error:
        error instanceof DaoReceiptVerificationError
          ? error.message
          : "The DAO receipt could not be reconciled. Its original request remains unresolved; check it before another write.",
    };
  } finally {
    clearTimeout(timer);
    // A timeout may publish UNKNOWN once, but its late callbacks can never publish or replace a hash.
    if (isCurrent()) update(current);
    retired = true;
  }
  return current;
}
