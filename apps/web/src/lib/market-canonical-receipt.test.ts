import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hash, TransactionReceipt } from "viem";
import {
  confirmMarketReceipt,
  confirmMarketWrite,
  marketWriteJournal,
  MarketReceiptFinalError,
  MarketReceiptPendingError,
  settleConfirmedSale,
} from "./market-transaction";
import {
  marketReceiptReadTimeoutMs,
  type MarketReceiptClient,
} from "./market-canonical-receipt";
import {
  testReceipt,
  testReceiptClient,
  testTransaction,
  testBlockHash,
} from "./market-receipt-test-client";
const original = `0x${"41".repeat(32)}` as Hash;
const next = `0x${"42".repeat(32)}` as Hash;
const wrong = `0x${"43".repeat(32)}` as Hash;
function evidence() {
  const wait = vi.fn().mockResolvedValue(testReceipt(original));
  const client = testReceiptClient(wait);
  client.getChainId = vi.fn().mockResolvedValue(560048);
  client.getBlock = vi.fn().mockResolvedValue({
    hash: testBlockHash,
    number: 12n,
  }) as MarketReceiptClient["getBlock"];
  client.getTransaction = vi
    .fn()
    .mockImplementation(async ({ hash }) =>
      testTransaction(hash),
    ) as MarketReceiptClient["getTransaction"];
  return { client, wait };
}
function journal() {
  const values = new Map<string, string>();
  return marketWriteJournal(
    {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => {
        values.set(k, v);
      },
      removeItem: (k) => {
        values.delete(k);
      },
    },
    "canonical-unit-" + Math.random(),
  );
}
async function retainUnlessProven(client: MarketReceiptClient) {
  const saved = journal();
  const entry = { hash: original, kind: "fill" as const };
  saved.record(entry);
  try {
    await confirmMarketReceipt(client, original);
    saved.clear(entry);
  } catch (error) {
    if (error instanceof MarketReceiptFinalError) saved.clear(entry);
    throw Object.assign(error as Error, {
      retained: saved.pending(),
      ready: () => saved.assertReady(),
    });
  }
}
afterEach(() => vi.useRealTimers());
describe("canonical shared market receipts", () => {
  it("regression market: rejects an unrelated successful receipt without freeing the original journal", async () => {
    const { client, wait } = evidence();
    wait.mockResolvedValue(testReceipt(wrong));
    await expect(retainUnlessProven(client)).rejects.toMatchObject({
      name: "Error",
      retained: { hash: original, kind: "fill" },
    });
  });
  it.each(["success", "reverted"] as const)(
    "regression market: retains a noncanonical %s receipt",
    async (status) => {
      const { client, wait } = evidence();
      wait.mockResolvedValue(testReceipt(original, status));
      client.getBlock = vi.fn().mockResolvedValue({
        hash: wrong,
        number: 12n,
      }) as MarketReceiptClient["getBlock"];
      await expect(retainUnlessProven(client)).rejects.toMatchObject({
        retained: { hash: original, kind: "fill" },
      });
    },
  );
  it("returns the original canonical receipt only after two block checks", async () => {
    const { client } = evidence();
    await expect(confirmMarketReceipt(client, original)).resolves.toEqual(
      testReceipt(original),
    );
    expect(client.getBlock).toHaveBeenCalledTimes(2);
    expect(client.getChainId).toHaveBeenCalledTimes(3);
    expect(client.getTransaction).toHaveBeenCalledTimes(2);
  });
  it("recognizes a canonical revert as a final noncompletion", async () => {
    const { client, wait } = evidence();
    wait.mockResolvedValue(testReceipt(original, "reverted"));
    await expect(confirmMarketReceipt(client, original)).rejects.toBeInstanceOf(
      MarketReceiptFinalError,
    );
    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["wrong receipt hash", { transactionHash: wrong }],
    ["zero block hash", { blockHash: `0x${"00".repeat(32)}` }],
    ["missing block number", { blockNumber: undefined }],
    ["negative block number", { blockNumber: -1n }],
    ["removed log", { logs: [{ removed: true }] }],
    ["unreported logs", { logs: undefined }],
    ["unresolved status", { status: "pending" }],
  ])("keeps %s unresolved", async (_label, changes) => {
    const { client, wait } = evidence();
    wait.mockResolvedValue({ ...testReceipt(original), ...changes });
    await expect(retainUnlessProven(client)).rejects.toMatchObject({
      retained: { hash: original },
    });
  });
  it.each([1, 560049])("never confirms through chain %s", async (chain) => {
    const { client, wait } = evidence();
    client.getChainId = vi.fn().mockResolvedValue(chain);
    await expect(confirmMarketReceipt(client, original)).rejects.toBeInstanceOf(
      MarketReceiptPendingError,
    );
    expect(wait).not.toHaveBeenCalled();
  });
  it("retains a receipt whose chain changes during reconciliation", async () => {
    const { client } = evidence();
    client.getChainId = vi
      .fn()
      .mockResolvedValueOnce(560048)
      .mockResolvedValue(1);
    await expect(confirmMarketReceipt(client, original)).rejects.toBeInstanceOf(
      MarketReceiptPendingError,
    );
  });
  it("retains a receipt reorged during its transaction read", async () => {
    const { client } = evidence();
    client.getBlock = vi
      .fn()
      .mockResolvedValueOnce({ hash: testBlockHash, number: 12n })
      .mockResolvedValue({
        hash: wrong,
        number: 12n,
      }) as MarketReceiptClient["getBlock"];
    await expect(retainUnlessProven(client)).rejects.toMatchObject({
      retained: { hash: original },
    });
  });
  it("does not leak RPC paths or credentials from failed evidence reads", async () => {
    const { client } = evidence();
    client.getTransaction = vi
      .fn()
      .mockRejectedValue(new Error("secret-token@internal-db/private-path"));
    await expect(confirmMarketReceipt(client, original)).rejects.toThrow(
      "not yet confirmed",
    );
    await expect(confirmMarketReceipt(client, original)).rejects.not.toThrow(
      "secret",
    );
  });
  it.each([
    ["hash", wrong],
    ["nonce", 8],
    ["from", "0x3000000000000000000000000000000000000003"],
    ["to", "0x3000000000000000000000000000000000000003"],
    ["input", "0xabcd"],
    ["value", 1n],
    ["blockHash", wrong],
    ["blockNumber", 13n],
    ["chainId", 1],
  ])("retains a changed settled %s", async (field, value) => {
    const { client } = evidence();
    let reads = 0;
    client.getTransaction = vi.fn().mockImplementation(async ({ hash }) => ({
      ...testTransaction(hash),
      ...(++reads === 2 ? { [field]: value } : {}),
    })) as MarketReceiptClient["getTransaction"];
    await expect(retainUnlessProven(client)).rejects.toMatchObject({
      retained: { hash: original },
    });
  });
  it("updates a repriced hash only after the canonical proof, preserving the exact call", async () => {
    const { client, wait } = evidence();
    const publish = vi.fn();
    wait.mockImplementation(async ({ onReplaced }) => {
      onReplaced({ reason: "repriced", transactionReceipt: testReceipt(next) });
      expect(publish).not.toHaveBeenCalled();
      return testReceipt(next);
    });
    await expect(
      confirmMarketReceipt(client, original, publish),
    ).resolves.toEqual(testReceipt(next));
    expect(publish.mock.calls).toEqual([[next]]);
  });
  it.each(["nonce", "from", "to", "input", "value"])(
    "rejects dishonest repricing with changed %s",
    async (field) => {
      const { client, wait } = evidence();
      const publish = vi.fn();
      wait.mockImplementation(async ({ onReplaced }) => {
        onReplaced({
          reason: "repriced",
          transactionReceipt: testReceipt(next),
        });
        return testReceipt(next);
      });
      client.getTransaction = vi.fn().mockImplementation(async ({ hash }) => ({
        ...testTransaction(hash),
        ...(hash === next
          ? {
              [field]:
                field === "nonce"
                  ? 8
                  : field === "value"
                    ? 1n
                    : field === "input"
                      ? "0xabcd"
                      : "0x3000000000000000000000000000000000000003",
            }
          : {}),
      })) as MarketReceiptClient["getTransaction"];
      await expect(
        confirmMarketReceipt(client, original, publish),
      ).rejects.toBeInstanceOf(MarketReceiptPendingError);
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it.each(["cancelled", "replaced"])(
    "confirms %s only after canonical original nonce consumption",
    async (reason) => {
      const { client, wait } = evidence();
      const publish = vi.fn();
      wait.mockImplementation(async ({ onReplaced }) => {
        onReplaced({ reason, transactionReceipt: testReceipt(next) });
        return testReceipt(next);
      });
      client.getTransaction = vi.fn().mockImplementation(async ({ hash }) => ({
        ...testTransaction(hash),
        ...(hash === next ? { input: "0xabcd", value: 1n } : {}),
      })) as MarketReceiptClient["getTransaction"];
      await expect(
        confirmMarketReceipt(client, original, publish),
      ).rejects.toBeInstanceOf(MarketReceiptFinalError);
      expect(publish).not.toHaveBeenCalled();
      expect(client.getBlock).toHaveBeenCalledTimes(2);
    },
  );
  it("retains a cancellation that does not consume the original nonce", async () => {
    const { client, wait } = evidence();
    wait.mockImplementation(async ({ onReplaced }) => {
      onReplaced({
        reason: "cancelled",
        transactionReceipt: testReceipt(next),
      });
      return testReceipt(next);
    });
    client.getTransaction = vi.fn().mockImplementation(async ({ hash }) => ({
      ...testTransaction(hash),
      nonce: hash === next ? 8 : 7,
    })) as MarketReceiptClient["getTransaction"];
    await expect(retainUnlessProven(client)).rejects.toMatchObject({
      retained: { hash: original },
    });
  });
  it.each(["chain", "original", "wait", "block", "settled"])(
    "bounds a stalled %s read and ignores its late replacement",
    async (stage) => {
      vi.useFakeTimers();
      const { client, wait } = evidence();
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const publish = vi.fn();
      let callback: ((v: unknown) => void) | undefined;
      if (stage === "chain")
        client.getChainId = vi.fn().mockReturnValue(pending);
      if (stage === "original")
        client.getTransaction = vi.fn().mockReturnValue(pending);
      if (stage === "wait")
        wait.mockImplementation(({ onReplaced }) => {
          callback = onReplaced;
          return pending;
        });
      if (stage === "block") client.getBlock = vi.fn().mockReturnValue(pending);
      if (stage === "settled")
        client.getTransaction = vi
          .fn()
          .mockResolvedValueOnce(testTransaction(original))
          .mockReturnValue(pending);
      const result = expect(
        confirmMarketReceipt(client, original, publish),
      ).rejects.toBeInstanceOf(MarketReceiptPendingError);
      await vi.advanceTimersByTimeAsync(marketReceiptReadTimeoutMs + 1);
      await result;
      callback?.({ reason: "repriced", transactionReceipt: testReceipt(next) });
      release(
        stage === "chain"
          ? 560048
          : stage === "block"
            ? { hash: testBlockHash, number: 12n }
            : stage === "wait"
              ? testReceipt(next)
              : testTransaction(original),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not open a fill after an unproven approval receipt", async () => {
    const { client, wait } = evidence();
    wait.mockResolvedValue(testReceipt(wrong));
    const settle = vi.fn().mockResolvedValue(next);
    await expect(
      settleConfirmedSale({
        client,
        approvePayment: async () => original,
        settle,
        onStage: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(MarketReceiptPendingError);
    expect(settle).not.toHaveBeenCalled();
  });
  it("preserves wallet refusal without starting chain reads", async () => {
    const { client } = evidence();
    await expect(
      confirmMarketWrite(client, async () => {
        throw new Error("User rejected");
      }),
    ).rejects.toThrow("User rejected");
    expect(client.getChainId).not.toHaveBeenCalled();
  });
});
