import { afterEach, expect, it, vi } from "vitest";
import {
  zeroHash,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";
import {
  checkDaoTransaction,
  createDaoActionSession,
  type DaoTransaction,
} from "./dao-action-state";
import { daoReceiptReadTimeoutMs } from "./dao-transaction-receipt";
const account = "0x1000000000000000000000000000000000000001" as Address,
  target = "0x1000000000000000000000000000000000000002" as Address,
  other = "0x1000000000000000000000000000000000000003" as Address;
const hash = `0x${"a".repeat(64)}` as Hash,
  next = `0x${"c".repeat(64)}` as Hash,
  blockHash = `0x${"b".repeat(64)}` as Hash;
const binding = { chainId: 560048 as const, account, targets: [target] };
const transaction: DaoTransaction = {
  hash,
  phase: "pending",
  success: "Vote confirmed.",
  request: { target, input: "0x12345678", value: "0" },
};
function fixture() {
  const state = { chain: 560048, blocks: 0, reorg: false };
  const receipt = {
    status: "success",
    transactionHash: hash,
    blockNumber: 77n,
    blockHash,
    logs: [],
  } as unknown as TransactionReceipt;
  const original = {
    hash,
    chainId: 560048,
    from: account,
    to: target,
    nonce: 7,
    value: 0n,
    input: "0x12345678",
  };
  const mock = {
    getChainId: vi.fn(async () => state.chain),
    getTransaction: vi.fn(async (input: { hash: Hash }) => ({
      ...original,
      hash: input.hash,
    })),
    getBlock: vi.fn(async () => {
      state.blocks++;
      return {
        number: 77n,
        hash: state.reorg && state.blocks > 1 ? next : blockHash,
      };
    }),
    waitForTransactionReceipt: vi.fn(async (_input: unknown) => receipt),
  };
  return {
    state,
    receipt,
    original,
    mock,
    client: mock as unknown as Parameters<
      typeof checkDaoTransaction
    >[0]["client"],
  };
}
function store() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
const check = (
  f: ReturnType<typeof fixture>,
  extra: Partial<Parameters<typeof checkDaoTransaction>[0]> = {},
) =>
  checkDaoTransaction({
    client: f.client,
    transaction,
    binding,
    isCurrent: () => true,
    update: vi.fn(),
    ...extra,
  });
afterEach(() => vi.useRealTimers());
it("regression: a noncanonical successful receipt cannot clear the original DAO journal", async () => {
  const f = fixture(),
    storage = store(),
    session = createDaoActionSession("regression-canonical");
  const lease = session.begin()!;
  session.awaitWallet(lease, () => storage);
  session.broadcast(lease, transaction, undefined, () => storage);
  f.mock.getBlock.mockResolvedValue({ number: 77n, hash: next });
  const result = await check(f, {
    isCurrent: () => session.isCurrent(lease),
    update: (value) =>
      session.updateTransaction(lease, hash, value, () => storage),
  });
  expect(result.phase).toBe("unknown");
  expect(session.getSnapshot().transaction?.phase).toBe("unknown");
  session.finish(lease);
  expect(session.begin()).toBeUndefined();
  expect(storage.values.size).toBe(1);
});
it("records canonical successful receipt proof for the reviewed exact call", async () => {
  const f = fixture(),
    result = await check(f);
  expect(result.phase).toBe("confirmed");
  expect(result.receipt).toEqual({
    originalHash: hash,
    transactionHash: hash,
    blockNumber: "77",
    blockHash,
    chainId: 560048,
  });
  expect(f.state.blocks).toBe(2);
});
it("keeps a receipt for another hash unresolved", async () => {
  const f = fixture();
  f.receipt.transactionHash = next;
  expect((await check(f)).phase).toBe("unknown");
});
it("rejects a reader on another chain before transaction lookup", async () => {
  const f = fixture();
  f.state.chain = 1;
  expect((await check(f)).phase).toBe("unknown");
  expect(f.mock.getTransaction).not.toHaveBeenCalled();
});
it.each([{ from: other }, { to: other }, { chainId: 1 }, { nonce: -1 }])(
  "rejects original account/deployment/chain/nonce mismatch %#",
  async (change) => {
    const f = fixture();
    Object.assign(f.original, change);
    expect((await check(f)).phase).toBe("unknown");
    expect(f.mock.waitForTransactionReceipt).not.toHaveBeenCalled();
  },
);
it.each([{ input: "0x87654321" }, { value: 1n }])(
  "rejects a wallet call changed from its saved reviewed binding %#",
  async (change) => {
    const f = fixture();
    Object.assign(f.original, change);
    expect((await check(f)).phase).toBe("unknown");
  },
);
it("rechecks canonical block after final transaction identity read", async () => {
  const f = fixture();
  f.state.reorg = true;
  expect((await check(f)).phase).toBe("unknown");
  expect(f.state.blocks).toBe(2);
});
it("does not accept a removed receipt log", async () => {
  const f = fixture();
  f.receipt.logs = [{ removed: true } as never];
  expect((await check(f)).phase).toBe("unknown");
});
it("only canonical reverted outcomes become failed", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  const result = await check(f);
  expect(result.phase).toBe("failed");
  expect(result.receipt?.blockHash).toBe(blockHash);
});
for (const reason of ["repriced", "cancelled"] as const)
  it(
    "binds " + reason + " replacement to original actor and nonce",
    async () => {
      const f = fixture(),
        onHash = vi.fn();
      f.receipt.transactionHash = next;
      f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
        (input as { onReplaced: (value: unknown) => void }).onReplaced({
          reason,
          transactionReceipt: f.receipt,
        });
        return f.receipt;
      });
      const result = await check(f, { onHash });
      expect(result.phase).toBe(reason === "repriced" ? "confirmed" : "failed");
      expect(result.receipt?.transactionHash).toBe(next);
      if (reason === "repriced")
        expect(onHash).toHaveBeenCalledExactlyOnceWith(next);
      else expect(onHash).not.toHaveBeenCalled();
    },
  );
it("does not replace the saved hash for another nonce", async () => {
  const f = fixture(),
    onHash = vi.fn();
  f.receipt.transactionHash = next;
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (value: unknown) => void }).onReplaced({
      reason: "repriced",
      transactionReceipt: f.receipt,
    });
    return f.receipt;
  });
  f.mock.getTransaction.mockImplementation(async ({ hash: h }) => ({
    ...f.original,
    hash: h,
    nonce: h === next ? 8 : 7,
  }));
  expect((await check(f, { onHash })).phase).toBe("unknown");
  expect(onHash).not.toHaveBeenCalled();
});
it("does not infer replacement when a callback repeats the original hash", async () => {
  const f = fixture();
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (value: unknown) => void }).onReplaced({
      reason: "cancelled",
      transactionReceipt: f.receipt,
    });
    return f.receipt;
  });
  expect((await check(f)).phase).toBe("unknown");
});
it("zero replacement hashes cannot overwrite the original journal", async () => {
  const f = fixture(),
    onHash = vi.fn();
  f.mock.waitForTransactionReceipt.mockImplementation(async (input) => {
    (input as { onReplaced: (value: unknown) => void }).onReplaced({
      reason: "repriced",
      transactionReceipt: { ...f.receipt, transactionHash: zeroHash },
    });
    return f.receipt;
  });
  expect((await check(f, { onHash })).phase).toBe("unknown");
  expect(onHash).not.toHaveBeenCalled();
});
it("times out unknown reads once and retires late replacement callbacks", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    update = vi.fn(),
    onHash = vi.fn();
  let finish: ((r: TransactionReceipt) => void) | undefined,
    notify: ((v: unknown) => void) | undefined;
  f.mock.waitForTransactionReceipt.mockImplementation((input) => {
    notify = (input as { onReplaced: (v: unknown) => void }).onReplaced;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = check(f, { update, onHash });
  await vi.advanceTimersByTimeAsync(daoReceiptReadTimeoutMs + 1);
  expect((await pending).phase).toBe("unknown");
  const count = update.mock.calls.length;
  expect(() =>
    notify!({
      reason: "repriced",
      transactionReceipt: { ...f.receipt, transactionHash: next },
    }),
  ).toThrow();
  finish!(f.receipt);
  await Promise.resolve();
  expect(onHash).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledTimes(count);
});
it("never exposes an RPC error's private contents in the public outcome", async () => {
  const f = fixture();
  f.mock.waitForTransactionReceipt.mockRejectedValue(
    Error("TEST_ONLY secret-token=PRIVATE_INTERNAL_PATH"),
  );
  const result = await check(f);
  expect(result.phase).toBe("unknown");
  expect(result.error).not.toContain("PRIVATE_INTERNAL");
  expect(result.error).not.toContain("secret-token");
});
it("persists the reviewed public call through an unresolved reload", () => {
  const storage = store(),
    first = createDaoActionSession("bound-request"),
    lease = first.begin()!;
  first.awaitWallet(lease, () => storage);
  first.broadcast(lease, transaction, undefined, () => storage);
  first.finish(lease);
  const restored = createDaoActionSession("bound-request");
  restored.restore(() => storage, target);
  expect(restored.getSnapshot().transaction?.request).toEqual(
    transaction.request,
  );
  expect(restored.getSnapshot().transaction?.phase).toBe("unknown");
  expect(restored.begin()).toBeUndefined();
});
it("rejects expanded request data while retaining the unknown request block", () => {
  const storage = store();
  storage.setItem(
    "artfi:dao-pending:invalid-request",
    JSON.stringify({
      version: 1,
      requestId: "pending",
      hash,
      request: { ...transaction.request, privateFile: "forbidden" },
    }),
  );
  const restored = createDaoActionSession("invalid-request");
  restored.restore(() => storage, target);
  expect(restored.getSnapshot().awaitingWallet).toBe(true);
  expect(restored.begin()).toBeUndefined();
});
