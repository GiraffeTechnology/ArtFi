import { afterEach, expect, it, vi } from "vitest";
import {
  encodeEventTopics,
  encodeFunctionData,
  zeroHash,
  type Hex,
  type PublicClient,
} from "viem";
import { charityEditionsAbi } from "./contracts";
import {
  charityEvidenceCall,
  isCharityEvidenceRecord,
  type CharityEvidenceRecord,
} from "./charity-evidence";
import {
  CharityEvidenceFinalError,
  readCharityEvidenceOutcome,
  prepareCharityEvidenceForView,
  charityEvidenceReadTimeoutMs,
} from "./charity-evidence-recovery";
const account = "0x1000000000000000000000000000000000000001",
  target = "0x1000000000000000000000000000000000000002";
const tx = `0x${"a".repeat(64)}` as Hex,
  next = `0x${"c".repeat(64)}` as Hex,
  blockHash = `0x${"b".repeat(64)}` as Hex,
  evidenceHash = `0x${"4".repeat(64)}` as Hex;
const record = (
  action: "sellout" | "donation" = "sellout",
): CharityEvidenceRecord => ({
  chainId: 560048,
  account,
  target,
  tokenId: "7",
  action,
  evidenceHash,
});
function fixture(action: "sellout" | "donation" = "sellout") {
  const rec = record(action),
    state = { chain: 560048, nonce: 5, readCount: 0 };
  const receipt = {
    transactionHash: tx,
    blockNumber: 77n,
    blockHash,
    status: "success",
    logs: [
      {
        address: target,
        removed: false,
        topics: encodeEventTopics({
          abi: charityEditionsAbi,
          eventName:
            action === "sellout"
              ? "SelloutRecorded"
              : "PhysicalDonationRecorded",
          args: { tokenId: 7n, evidenceHash },
        }),
        data: "0x",
      },
    ],
  };
  const transaction = {
    hash: tx,
    from: account,
    to: target,
    value: 0n,
    nonce: 5,
    input: encodeFunctionData(charityEvidenceCall(rec)),
  };
  const mock = {
    getChainId: vi.fn(async () => state.chain),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => ({
      ...transaction,
      hash,
      nonce: hash === tx ? 5 : state.nonce,
    })),
    waitForTransactionReceipt: vi.fn(async (_input: unknown) => receipt),
    getBlock: vi.fn(async () => ({
      number: 77n,
      hash: blockHash,
      timestamp: 10n,
    })),
    readContract: vi.fn(async () => {
      state.readCount++;
      return {
        createdAt: 1n,
        distributionWallet: account,
        soldOutAt: action === "sellout" ? 10n : 5n,
        physicalDonationRecordedAt: action === "donation" ? 10n : 0n,
        selloutEvidenceHash: evidenceHash,
        physicalDonationEvidenceHash:
          action === "donation" ? evidenceHash : zeroHash,
      };
    }),
    simulateContract: vi.fn(async () => ({})),
  };
  return {
    rec,
    state,
    receipt,
    transaction,
    mock,
    client: mock as unknown as PublicClient,
  };
}
afterEach(() => vi.useRealTimers());
it.each(["sellout", "donation"] as const)(
  "reconciles %s from its exact call, event and canonical state",
  async (action) => {
    const f = fixture(action);
    expect(
      (await readCharityEvidenceOutcome(f.client, f.rec, tx, () => {})).outcome,
    ).toMatchObject({
      status: "confirmed",
      originalHash: tx,
      transactionHash: tx,
      blockNumber: "77",
      blockHash,
    });
  },
);
it("does not accept a returned receipt for another transaction", async () => {
  const f = fixture();
  f.receipt.transactionHash = next;
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
  ).rejects.toThrow("original request");
});
it("does not release a reverted transaction before canonical validation", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  f.mock.getBlock.mockResolvedValue({
    number: 77n,
    hash: next,
    timestamp: 10n,
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
  ).rejects.not.toBeInstanceOf(CharityEvidenceFinalError);
});
it("retains a canonical terminal outcome without claiming evidence completion", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
  ).rejects.toMatchObject({
    outcome: {
      originalHash: tx,
      transactionHash: tx,
      status: "reverted",
      blockHash,
    },
  });
  expect(f.state.readCount).toBe(0);
});
for (const reason of ["repriced", "cancelled"] as const)
  it("binds " + reason + " to the original actor and nonce", async () => {
    const f = fixture(),
      changed = vi.fn();
    f.receipt.transactionHash = next;
    f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
      (input as { onReplaced: (v: unknown) => void }).onReplaced({
        reason,
        transactionReceipt: f.receipt,
      });
      return f.receipt;
    });
    if (reason === "repriced") {
      expect(
        (
          await readCharityEvidenceOutcome(
            f.client,
            f.rec,
            tx,
            () => {},
            changed,
          )
        ).transactionHash,
      ).toBe(next);
      expect(changed).toHaveBeenCalledExactlyOnceWith(next);
    } else {
      await expect(
        readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}, changed),
      ).rejects.toMatchObject({
        outcome: { status: "replaced", transactionHash: next },
      });
      expect(changed).not.toHaveBeenCalled();
    }
  });
it("rejects a replacement consuming another nonce without changing the journal", async () => {
  const f = fixture(),
    changed = vi.fn();
  f.state.nonce = 6;
  f.receipt.transactionHash = next;
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (v: unknown) => void }).onReplaced({
      reason: "cancelled",
      transactionReceipt: f.receipt,
    });
    return f.receipt;
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}, changed),
  ).rejects.toThrow("actor and nonce");
  expect(changed).not.toHaveBeenCalled();
});
it("rejects a zero replacement hash without changing the journal", async () => {
  const f = fixture(),
    changed = vi.fn();
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (v: unknown) => void }).onReplaced({
      reason: "repriced",
      transactionReceipt: { ...f.receipt, transactionHash: zeroHash },
    });
    return f.receipt;
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}, changed),
  ).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
});
it("does not infer replacement from a callback reusing the original hash", async () => {
  const f = fixture();
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (v: unknown) => void }).onReplaced({
      reason: "cancelled",
      transactionReceipt: f.receipt,
    });
    return f.receipt;
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
  ).rejects.toThrow("distinct");
});
it("rejects a chain change after receipt-state reads", async () => {
  const f = fixture();
  f.mock.readContract.mockImplementation(async () => {
    f.state.chain = 1;
    return {
      createdAt: 1n,
      distributionWallet: account,
      soldOutAt: 10n,
      physicalDonationRecordedAt: 0n,
      selloutEvidenceHash: evidenceHash,
      physicalDonationEvidenceHash: zeroHash,
    };
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
  ).rejects.toThrow();
});
it("retires a late original-transaction read before receipt lookup", async () => {
  const f = fixture();
  let active = true;
  f.mock.getTransaction.mockImplementation(async ({ hash }) => {
    active = false;
    return { ...f.transaction, hash };
  });
  await expect(
    readCharityEvidenceOutcome(f.client, f.rec, tx, () => {
      if (!active) throw Error("Retired view");
    }),
  ).rejects.toThrow("Retired view");
  expect(f.mock.waitForTransactionReceipt).not.toHaveBeenCalled();
});
it("bounds unknown receipt lookup and ignores its late result", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release: ((v: typeof f.receipt) => void) | undefined;
  f.mock.waitForTransactionReceipt.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const p = readCharityEvidenceOutcome(f.client, f.rec, tx, () => {}),
    rejected = expect(p).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(charityEvidenceReadTimeoutMs + 1);
  await rejected;
  release!(f.receipt);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.state.readCount).toBe(0);
});
it("bounds preflight before any wallet authority and retires late reads", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let release: ((v: number) => void) | undefined;
  f.mock.getChainId.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const p = prepareCharityEvidenceForView(f.client, f.rec, undefined, () => {}),
    rejected = expect(p).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(charityEvidenceReadTimeoutMs + 1);
  await rejected;
  release!(560048);
  await Promise.resolve();
  expect(f.mock.simulateContract).not.toHaveBeenCalled();
});
it("accepts only exact public terminal proof fields in saved recovery data", () => {
  const outcome = {
    originalHash: tx,
    transactionHash: tx,
    blockNumber: "77",
    blockHash,
    status: "confirmed" as const,
  };
  expect(isCharityEvidenceRecord({ ...record(), outcome })).toBe(true);
  expect(
    isCharityEvidenceRecord({
      ...record(),
      outcome: { ...outcome, blockNumber: 77 },
    }),
  ).toBe(false);
  expect(
    isCharityEvidenceRecord({
      ...record(),
      outcome: { ...outcome, privateFile: "forbidden" },
    }),
  ).toBe(false);
});
