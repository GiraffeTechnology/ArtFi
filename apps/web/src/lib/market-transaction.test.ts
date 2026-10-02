import { describe, expect, it, vi } from "vitest";
import type { Hash, PublicClient, TransactionReceipt } from "viem";

import {
  confirmMarketWrite,
  settleConfirmedSale,
  marketWriteJournal,
} from "./market-transaction";

const approvalHash = `0x${"11".repeat(32)}` as Hash;
const fillHash = `0x${"22".repeat(32)}` as Hash;
const replacementHash = `0x${"33".repeat(32)}` as Hash;
const receipt = (hash: Hash, status: "success" | "reverted" = "success") =>
  ({ transactionHash: hash, status }) as TransactionReceipt;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function receiptClient(wait: ReturnType<typeof vi.fn>) {
  return { waitForTransactionReceipt: wait } as unknown as Pick<
    PublicClient,
    "waitForTransactionReceipt"
  >;
}

describe("confirmed market transactions", () => {
  it("does not settle on an approval hash or complete on a fill hash", async () => {
    const approved = deferred<TransactionReceipt>();
    const filled = deferred<TransactionReceipt>();
    const wait = vi
      .fn()
      .mockReturnValueOnce(approved.promise)
      .mockReturnValueOnce(filled.promise);
    const approvePayment = vi.fn().mockResolvedValue(approvalHash);
    const settle = vi.fn().mockResolvedValue(fillHash);
    const onStage = vi.fn();
    const onHash = vi.fn();
    let complete = false;
    const operation = settleConfirmedSale({
      client: receiptClient(wait),
      approvePayment,
      settle,
      onStage,
      onHash,
    }).then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));
    expect(onHash).toHaveBeenCalledWith(approvalHash);
    expect(settle).not.toHaveBeenCalled();
    expect(complete).toBe(false);
    approved.resolve(receipt(approvalHash));
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
    expect(settle).toHaveBeenCalledOnce();
    expect(onHash).toHaveBeenLastCalledWith(fillHash);
    expect(complete).toBe(false);
    filled.resolve(receipt(fillHash));
    await operation;
    expect(complete).toBe(true);
    expect(onStage.mock.calls).toEqual([["approving"], ["filling"]]);
  });

  it("never requests a fill after approval reverts", async () => {
    const settle = vi.fn().mockResolvedValue(fillHash);
    await expect(
      settleConfirmedSale({
        client: receiptClient(
          vi.fn().mockResolvedValue(receipt(approvalHash, "reverted")),
        ),
        approvePayment: vi.fn().mockResolvedValue(approvalHash),
        settle,
        onStage: vi.fn(),
      }),
    ).rejects.toThrow("reverted on chain");
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not report a reverted settlement as complete", async () => {
    const wait = vi
      .fn()
      .mockResolvedValueOnce(receipt(approvalHash))
      .mockResolvedValueOnce(receipt(fillHash, "reverted"));
    await expect(
      settleConfirmedSale({
        client: receiptClient(wait),
        approvePayment: vi.fn().mockResolvedValue(approvalHash),
        settle: vi.fn().mockResolvedValue(fillHash),
        onStage: vi.fn(),
      }),
    ).rejects.toThrow("reverted on chain");
  });

  it("keeps a failed receipt lookup unconfirmed instead of guessing success", async () => {
    await expect(
      confirmMarketWrite(
        receiptClient(vi.fn().mockRejectedValue(new Error("Receipt timeout"))),
        vi.fn().mockResolvedValue(fillHash),
      ),
    ).rejects.toThrow("not yet confirmed");
  });

  it("does not wait for a receipt when the wallet rejects the request", async () => {
    const wait = vi.fn();
    await expect(
      confirmMarketWrite(
        receiptClient(wait),
        vi.fn().mockRejectedValue(new Error("User rejected")),
      ),
    ).rejects.toThrow("User rejected");
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "replaced"])(
    "rejects a successful but %s transaction",
    async (reason) => {
      const wait = vi.fn().mockImplementation(async ({ onReplaced }) => {
        onReplaced({ reason, transactionReceipt: receipt(replacementHash) });
        return receipt(replacementHash);
      });
      await expect(
        confirmMarketWrite(
          receiptClient(wait),
          vi.fn().mockResolvedValue(fillHash),
        ),
      ).rejects.toThrow("cancelled or replaced");
    },
  );

  it("accepts repricing and reports the actual confirmed hash", async () => {
    const onHash = vi.fn();
    const wait = vi.fn().mockImplementation(async ({ onReplaced }) => {
      onReplaced({
        reason: "repriced",
        transactionReceipt: receipt(replacementHash),
      });
      return receipt(replacementHash);
    });
    await expect(
      confirmMarketWrite(
        receiptClient(wait),
        vi.fn().mockResolvedValue(fillHash),
        onHash,
      ),
    ).resolves.toEqual(receipt(replacementHash));
    expect(onHash.mock.calls).toEqual([[fillHash], [replacementHash]]);
  });
});

describe("interrupted settlement recovery", () => {
  it("does not submit settlement after navigation or a wallet-context change", async () => {
    let current = true;
    const approved = deferred<TransactionReceipt>();
    const settle = vi.fn().mockResolvedValue(fillHash);
    const wait = vi.fn().mockReturnValue(approved.promise);
    const operation = settleConfirmedSale({
      client: receiptClient(wait),
      approvePayment: vi.fn().mockResolvedValue(approvalHash),
      settle,
      onStage: vi.fn(),
      isCurrent: () => current,
    });
    const result = expect(operation).rejects.toThrow(
      "screen or wallet changed",
    );
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    current = false;
    approved.resolve(receipt(approvalHash));
    await result;
    expect(settle).not.toHaveBeenCalled();
  });

  it("keeps an unresolved fill blocked across remounts and isolates wallet contexts", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const firstScreen = marketWriteJournal(
      storage,
      "hoodi:market:asset:buyerA",
    );
    firstScreen.record({ hash: fillHash, kind: "fill" });
    const returnedScreen = marketWriteJournal(
      storage,
      "hoodi:market:asset:buyerA",
    );
    expect(returnedScreen.pending()).toEqual({ hash: fillHash, kind: "fill" });
    expect(() => returnedScreen.assertReady()).toThrow("not yet confirmed");
    expect(() =>
      marketWriteJournal(storage, "hoodi:market:asset:buyerB").assertReady(),
    ).not.toThrow();
    returnedScreen.clear();
    expect(() => returnedScreen.assertReady()).not.toThrow();
  });

  it("does not silently discard a corrupt pending record", () => {
    const journal = marketWriteJournal(
      { getItem: () => "broken", setItem: vi.fn(), removeItem: vi.fn() },
      "context",
    );
    expect(() => journal.assertReady()).toThrow("not yet confirmed");
    expect(() => journal.pending()).toThrow("could not be read");
  });
});

it("shares the wallet-prompt lock across unmount and remount before a hash exists", () => {
  const storage = {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const firstScreen = marketWriteJournal(storage, "prompt-test-context");
  firstScreen.lockWalletRequest();
  const returnedScreen = marketWriteJournal(storage, "prompt-test-context");
  expect(() => returnedScreen.assertReady()).toThrow("wallet request");
  expect(() => returnedScreen.lockWalletRequest()).toThrow("wallet request");
  firstScreen.unlockWalletRequest();
  expect(() => returnedScreen.assertReady()).not.toThrow();
});
