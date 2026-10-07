import { describe, expect, it } from "vitest";
import type { Hash, PublicClient, TransactionReceipt } from "viem";
import { currentOperation } from "./current-operation";
import {
  confirmMarketReceipt,
  MarketReceiptFinalError,
} from "./market-transaction";
import { createSetupRecoverySession } from "./setup-recovery";

const hash = `0x${"12".repeat(32)}` as Hash;
const replacement = `0x${"34".repeat(32)}` as Hash;
const data = {
  intentId: "public-intent",
  uploadId: "public-upload",
  stage: "prepared",
};
function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}
function session(target = store(), context = "mint:560048:wallet-a") {
  const recovery = createSetupRecoverySession(
    context,
    (value): value is typeof data =>
      Boolean(
        value &&
        typeof value === "object" &&
        (value as typeof data).intentId === data.intentId,
      ),
  );
  recovery.restore(() => target);
  return { recovery, target };
}
function start() {
  const value = session();
  const lease = value.recovery.begin()!;
  value.recovery.save(lease, data);
  return { ...value, lease };
}
const receipt = (
  transactionHash = hash,
  status: "success" | "reverted" = "success",
) => ({ transactionHash, status, logs: [] }) as unknown as TransactionReceipt;
const client = (wait: unknown) =>
  ({ waitForTransactionReceipt: wait }) as Pick<
    PublicClient,
    "waitForTransactionReceipt"
  >;

describe("bounded public setup recovery", () => {
  it("takes a synchronous preparation lease and preserves the exact upload/intent after a wallet refusal", () => {
    const { recovery, lease, target } = start();
    expect(recovery.begin()).toBeUndefined();
    recovery.awaitWallet(lease, "mint");
    recovery.rejected(lease);
    recovery.finish(lease);
    const reload = session(target).recovery;
    expect(reload.getSnapshot().record?.data).toEqual(data);
    expect(reload.begin()).toBeDefined();
  });
  it("persists uncertainty before prompting and keeps it blocked after an error and reload", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "mint");
    recovery.fail(lease, new Error("RPC disconnected"));
    recovery.finish(lease);
    const reload = session(target).recovery;
    expect(reload.getSnapshot().record?.pending).toMatchObject({
      step: "mint",
    });
    expect(reload.getSnapshot().error).toContain("no known transaction hash");
    expect(reload.begin()).toBeUndefined();
    expect(reload.begin(true)).toBeDefined();
  });
  it("journals a late hash under its original context after view retirement", async () => {
    const { recovery, lease, target } = start();
    const view = currentOperation();
    recovery.awaitWallet(lease, "mint");
    let release!: (hash: Hash) => void;
    const response = new Promise<Hash>((resolve) => {
      release = resolve;
    });
    const continuation = response.then((value) =>
      recovery.broadcast(lease, value),
    );
    view.retire();
    release(hash);
    await continuation;
    expect(view.isCurrent()).toBe(false);
    expect(() => view.assertCurrent()).toThrow();
    expect(session(target).recovery.getSnapshot().record?.pending?.hash).toBe(
      hash,
    );
    expect(
      session(target, "mint:560048:wallet-b").recovery.getSnapshot().record,
    ).toBeUndefined();
  });
  it("retains a broadcast and confirmed setup when submission logging fails", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "create");
    recovery.broadcast(lease, hash);
    expect(session(target).recovery.getSnapshot().record?.pending?.hash).toBe(
      hash,
    );
    recovery.resolved(lease, { ...data, stage: "created" });
    recovery.fail(lease, new Error("Submission log 503"));
    recovery.finish(lease);
    expect(session(target).recovery.getSnapshot().record?.data.stage).toBe(
      "created",
    );
    expect(
      session(target).recovery.getSnapshot().record?.pending,
    ).toBeUndefined();
  });
  it("never treats deleted or corrupted storage as cancellation", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "deposit");
    target.values.clear();
    recovery.broadcast(lease, hash);
    recovery.finish(lease);
    expect(recovery.getSnapshot().record?.pending?.hash).toBe(hash);
    expect(recovery.begin()).toBeUndefined();
    const broken = store();
    broken.setItem("artfi:setup:mint:560048:wallet-a", "not-json");
    expect(session(broken).recovery.begin()).toBeUndefined();
  });
  it("blocks prompting when durable storage cannot write and retains a hash if storage fails later", () => {
    const { recovery, lease, target } = start();
    const write = target.setItem;
    target.setItem = () => {
      throw new Error("quota");
    };
    expect(() => recovery.awaitWallet(lease, "mint")).toThrow("quota");
    expect(recovery.getSnapshot().record?.pending).toBeUndefined();
    target.setItem = write;
    recovery.awaitWallet(lease, "mint");
    target.setItem = () => {
      throw new Error("quota");
    };
    recovery.broadcast(lease, hash);
    recovery.finish(lease);
    expect(recovery.getSnapshot().record?.pending?.hash).toBe(hash);
    expect(recovery.begin()).toBeUndefined();
    expect(
      session(target).recovery.getSnapshot().record?.pending?.hash,
    ).toBeUndefined();
  });
  it("can reconcile a retained hash after a transient storage write failure without another send", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "deposit");
    const write = target.setItem;
    target.setItem = () => {
      throw new Error("quota");
    };
    recovery.broadcast(lease, hash);
    recovery.finish(lease);
    expect(recovery.begin()).toBeUndefined();
    target.setItem = write;
    const checking = recovery.begin(true)!;
    expect(recovery.getSnapshot().record?.pending?.hash).toBe(hash);
    recovery.resolved(checking, { ...data, stage: "confirmed" });
    recovery.finish(checking);
    expect(recovery.getSnapshot().blocked).toBe(false);
    expect(session(target).recovery.getSnapshot().record?.data.stage).toBe(
      "confirmed",
    );
    expect(recovery.begin()).toBeDefined();
  });
  it("does not replace a newer stored request with a stale response", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "approve");
    const key = "artfi:setup:mint:560048:wallet-a";
    const newer = JSON.parse(target.getItem(key)!);
    newer.pending.id = "newer-request";
    target.setItem(key, JSON.stringify(newer));
    recovery.broadcast(lease, hash);
    recovery.finish(lease);
    expect(JSON.parse(target.getItem(key)!).pending.id).toBe("newer-request");
    expect(JSON.parse(target.getItem(key)!).pending.hash).toBeUndefined();
    expect(recovery.begin()).toBeUndefined();
  });
  it.each(["approve", "deposit", "fractionalize"])(
    "retains %s hashes across timeout and later confirmation",
    async (step) => {
      const { recovery, lease, target } = start();
      recovery.awaitWallet(lease, step);
      recovery.broadcast(lease, hash);
      await expect(
        confirmMarketReceipt(
          client(async () => {
            throw new Error("timeout");
          }),
          hash,
        ),
      ).rejects.toThrow("not yet confirmed");
      recovery.finish(lease);
      const reload = session(target).recovery;
      expect(reload.begin()).toBeUndefined();
      const checking = reload.begin(true)!;
      await confirmMarketReceipt(
        client(async () => receipt()),
        hash,
      );
      reload.resolved(checking, { ...data, stage: "confirmed" });
      reload.finish(checking);
      expect(reload.getSnapshot().record?.pending).toBeUndefined();
    },
  );
  it("retains only repriced identical-operation hashes and leaves unrelated replacements final", async () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "deposit");
    recovery.broadcast(lease, hash);
    const wait = async ({
      onReplaced,
    }: {
      onReplaced: (value: unknown) => void;
    }) => {
      onReplaced({
        reason: "repriced",
        transactionReceipt: receipt(replacement),
      });
      return receipt(replacement);
    };
    await confirmMarketReceipt(client(wait), hash, (next) =>
      recovery.repriced(lease, next),
    );
    expect(session(target).recovery.getSnapshot().record?.pending?.hash).toBe(
      replacement,
    );
  });
  it.each(["cancelled", "replaced", "reverted"])(
    "permits retry only after proven %s, without declaring completion",
    async (reason) => {
      const { recovery, lease } = start();
      recovery.awaitWallet(lease, "fractionalize");
      recovery.broadcast(lease, hash);
      try {
        await confirmMarketReceipt(
          client(
            async ({
              onReplaced,
            }: {
              onReplaced: (value: unknown) => void;
            }) => {
              if (reason !== "reverted")
                onReplaced({
                  reason,
                  transactionReceipt: receipt(replacement),
                });
              return receipt(
                hash,
                reason === "reverted" ? "reverted" : "success",
              );
            },
          ),
          hash,
        );
        expect.fail("Expected a final non-completion");
      } catch (error) {
        expect(error).toBeInstanceOf(MarketReceiptFinalError);
        recovery.resolved(lease, data);
      }
      recovery.finish(lease);
      expect(recovery.getSnapshot().record?.data.stage).toBe("prepared");
      expect(recovery.begin()).toBeDefined();
    },
  );
});
