import type { Hash, PublicClient } from "viem";

type ReceiptClient = Pick<PublicClient, "waitForTransactionReceipt">;
export type MarketWriteKind = "approval" | "fill" | "withdrawal";
export type PendingMarketWrite = { hash: Hash; kind: MarketWriteKind };

export class MarketReceiptPendingError extends Error {
  constructor() {
    super(
      "The transaction was broadcast but its receipt is not yet confirmed. Check the transaction before trying another submission.",
    );
  }
}
export class MarketReceiptFinalError extends Error {}

export async function confirmMarketReceipt(
  client: ReceiptClient,
  hash: Hash,
  onHash?: (hash: Hash) => void,
) {
  let changedTransaction = false;
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      onReplaced(replacement) {
        // Do not journal a cancelled or different operation as this fill. If the page
        // closes during replacement handling, reconciliation must not accept that hash.
        if (replacement.reason === "repriced")
          onHash?.(replacement.transactionReceipt.transactionHash);
        else changedTransaction = true;
      },
    });
  } catch {
    throw new MarketReceiptPendingError();
  }
  if (changedTransaction) {
    throw new MarketReceiptFinalError(
      "The transaction was cancelled or replaced. No completion is recorded.",
    );
  }
  if (receipt.status !== "success") {
    throw new MarketReceiptFinalError(
      "The transaction reverted on chain. No completion is recorded.",
    );
  }
  return receipt;
}

/** A broadcast hash is pending, never proof that approval or settlement succeeded. */
export async function confirmMarketWrite(
  client: ReceiptClient,
  submit: () => Promise<Hash>,
  onHash?: (hash: Hash) => void,
) {
  const hash = await submit();
  onHash?.(hash);
  return confirmMarketReceipt(client, hash, onHash);
}

/** Approval success never authorizes a departed or changed screen to open another wallet request. */
export async function settleConfirmedSale({
  client,
  approvePayment,
  settle,
  onStage,
  onHash,
  isCurrent = () => true,
}: {
  client: ReceiptClient;
  approvePayment: () => Promise<Hash>;
  settle: () => Promise<Hash>;
  onStage: (stage: "approving" | "filling") => void;
  onHash?: (hash: Hash) => void;
  isCurrent?: () => boolean;
}) {
  if (!isCurrent())
    throw new Error(
      "The wallet or asset context changed. Start again from the current screen.",
    );
  onStage("approving");
  await confirmMarketWrite(client, approvePayment, onHash);
  if (!isCurrent())
    throw new Error(
      "The screen or wallet changed after approval. No settlement was requested.",
    );
  onStage("filling");
  return confirmMarketWrite(client, settle, onHash);
}

const activeWalletRequests = new Set<string>();

/** Browser-session journal: unresolved broadcasts survive route changes and refreshes. No signatures or keys. */
export function marketWriteJournal(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
) {
  const listeners = new Set<() => void>();
  const getSnapshot = () => storage.getItem(key);
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending(): PendingMarketWrite | undefined {
      const saved = getSnapshot();
      if (!saved) return undefined;
      try {
        const parsed = JSON.parse(saved) as PendingMarketWrite;
        if (
          /^0x[a-fA-F0-9]{64}$/.test(parsed.hash) &&
          ["approval", "fill", "withdrawal"].includes(parsed.kind)
        )
          return parsed;
      } catch {
        /* Corrupt journals remain blocked until inspected rather than permitting a duplicate send. */
      }
      throw new Error(
        "The pending-transaction record could not be read. Do not resubmit until its transaction is checked.",
      );
    },
    assertReady() {
      if (getSnapshot()) throw new MarketReceiptPendingError();
      if (activeWalletRequests.has(key))
        throw new Error(
          "A wallet request for this asset is still awaiting a response. Finish or reject it in your wallet before trying again.",
        );
    },
    lockWalletRequest() {
      this.assertReady();
      activeWalletRequests.add(key);
    },
    unlockWalletRequest() {
      activeWalletRequests.delete(key);
    },
    record(pending: PendingMarketWrite) {
      storage.setItem(key, JSON.stringify(pending));
      listeners.forEach((listener) => listener());
    },
    clear() {
      storage.removeItem(key);
      listeners.forEach((listener) => listener());
    },
  };
}
