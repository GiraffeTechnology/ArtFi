import { testReceipt, testReceiptClient } from "./market-receipt-test-client";
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
) => testReceipt(transactionHash, status);
const client = testReceiptClient;

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
                reason === "reverted" ? hash : replacement,
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

describe("private setup failures preserve original recovery", () => {
  const safe =
    "Setup could not be completed. Check the saved setup and any existing transaction before retrying.";
  const privateFailure =
    "TEST_ONLY wallet calldata=0x1234 signature=TEST_ONLY-signature " +
    "Authorization=TEST_ONLY-token " +
    "sensitive-provider-detail ".repeat(2000);

  it.each(["prepared", "awaiting-wallet", "broadcast"] as const)(
    "keeps the %s record intact while hiding provider details",
    (phase) => {
      const { recovery, lease, target } = start();
      if (phase !== "prepared") recovery.awaitWallet(lease, "mint");
      if (phase === "broadcast") recovery.broadcast(lease, hash);
      const record = structuredClone(recovery.getSnapshot().record);
      const stored = [...target.values.entries()];
      recovery.fail(lease, new Error(privateFailure));
      expect(recovery.getSnapshot().error).toContain(safe);
      expect(recovery.getSnapshot().error).not.toContain("TEST_ONLY");
      expect(recovery.getSnapshot().error.length).toBeLessThan(400);
      expect(recovery.getSnapshot().record).toEqual(record);
      expect([...target.values.entries()]).toEqual(stored);
      if (phase === "awaiting-wallet")
        expect(recovery.getSnapshot().error).toContain(
          "no known transaction hash",
        );
      else expect(recovery.getSnapshot().error).toBe(safe);
      recovery.finish(lease);
      const reload = session(target).recovery;
      expect(reload.getSnapshot().record).toEqual(record);
      if (phase === "prepared") expect(reload.begin()).toBeDefined();
      else {
        expect(reload.begin()).toBeUndefined();
        expect(reload.begin(true)).toBeDefined();
      }
    },
  );

  it.each(["message", "toString"] as const)(
    "does not inspect an untrusted failure %s",
    (property) => {
      const { recovery, lease } = start();
      const failure = Object.defineProperty(new Error(), property, {
        get() {
          throw new Error("TEST_ONLY forbidden error accessor");
        },
      });
      expect(() => recovery.fail(lease, failure)).not.toThrow();
      expect(recovery.getSnapshot().error).toBe(safe);
    },
  );

  it("retains a late original hash after a hidden wallet failure and view reload", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "mint");
    recovery.fail(lease, new Error(privateFailure));
    expect(recovery.begin()).toBeUndefined();
    expect(recovery.begin(true)).toBeUndefined();
    recovery.broadcast(lease, hash);
    recovery.finish(lease);
    const reload = session(target).recovery;
    expect(reload.getSnapshot().record?.pending?.hash).toBe(hash);
    expect(reload.begin()).toBeUndefined();
    const checking = reload.begin(true)!;
    reload.resolved(checking, { ...data, stage: "confirmed" });
    reload.finish(checking);
    expect(reload.getSnapshot().record?.pending).toBeUndefined();
    expect(reload.getSnapshot().record?.data.stage).toBe("confirmed");
    expect(reload.begin()).toBeDefined();
  });

  it("ignores an expired failure lease without replacing the current result", () => {
    const { recovery, lease } = start();
    recovery.finish(lease);
    const next = recovery.begin()!;
    recovery.fail(next, new Error(privateFailure));
    const before = recovery.getSnapshot();
    let notifications = 0;
    const stop = recovery.subscribe(() => notifications++);
    recovery.fail(lease, new Error(privateFailure));
    expect(recovery.getSnapshot()).toBe(before);
    expect(notifications).toBe(0);
    stop();
  });

  it("keeps a storage-failed hash blocked until the original request is reconciled", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "deposit");
    const write = target.setItem;
    target.setItem = () => {
      throw new Error(privateFailure);
    };
    recovery.broadcast(lease, hash);
    recovery.fail(lease, new Error(privateFailure));
    expect(recovery.getSnapshot().blocked).toBe(true);
    expect(recovery.getSnapshot().record?.pending?.hash).toBe(hash);
    expect(recovery.getSnapshot().error).toBe(safe);
    recovery.finish(lease);
    expect(recovery.begin()).toBeUndefined();
    target.setItem = write;
    const checking = recovery.begin(true)!;
    recovery.resolved(checking, { ...data, stage: "confirmed" });
    recovery.finish(checking);
    expect(session(target).recovery.getSnapshot().record?.data.stage).toBe(
      "confirmed",
    );
    expect(recovery.begin()).toBeDefined();
  });

  it("preserves a repriced original request through a hidden reconciliation failure", () => {
    const { recovery, lease, target } = start();
    recovery.awaitWallet(lease, "deposit");
    recovery.broadcast(lease, hash);
    recovery.repriced(lease, replacement);
    recovery.fail(lease, new Error(privateFailure));
    recovery.finish(lease);
    const reload = session(target).recovery;
    expect(reload.getSnapshot().record?.pending?.hash).toBe(replacement);
    expect(reload.begin()).toBeUndefined();
    const checking = reload.begin(true)!;
    reload.resolved(checking, { ...data, stage: "confirmed" });
    reload.finish(checking);
    expect(reload.getSnapshot().record?.pending).toBeUndefined();
    expect(reload.begin()).toBeDefined();
  });
});
