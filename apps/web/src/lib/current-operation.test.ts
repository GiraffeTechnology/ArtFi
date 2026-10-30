import { describe, expect, it, vi } from "vitest";
import { currentOperation, reconcileCurrentView } from "./current-operation";

describe("current operation", () => {
  it("permanently retires old continuations without affecting a fresh operation", () => {
    const old = currentOperation();
    expect(old.isCurrent()).toBe(true);
    old.retire();
    const fresh = currentOperation();
    expect(() => old.assertCurrent()).toThrow(/session or terms changed/);
    expect(old.isCurrent()).toBe(false);
    expect(() => fresh.assertCurrent()).not.toThrow();
  });
  it("checks retirement after async work before another wallet request", async () => {
    const operation = currentOperation();
    const result = Promise.resolve().then(() => operation.assertCurrent());
    operation.retire();
    await expect(result).rejects.toThrow(/No further wallet request/);
  });
});

describe("receipt view continuation", () => {
  it.each(["success", "error"] as const)(
    "does not publish old receipt %s after terms change during refresh",
    async (outcome) => {
      const operation = currentOperation();
      const publish = vi.fn();
      const fail = vi.fn();
      let finish!: () => void;
      let reject!: (error: Error) => void;
      const refreshed = new Promise<void>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      });
      const refresh = vi.fn(() => refreshed);
      const pending = reconcileCurrentView({
        isCurrent: operation.isCurrent,
        read: async () => ({ intentHash: "old-order" }),
        refresh,
        publish,
        fail,
      });
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      operation.retire();
      if (outcome === "success") finish();
      else reject(new Error("old refresh failed"));
      await pending;
      expect(publish).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    },
  );
  it("publishes the matching receipt only after its current queries complete", async () => {
    const operation = currentOperation();
    const publish = vi.fn();
    const fail = vi.fn();
    const result = { intentHash: "current-order" };
    await reconcileCurrentView({
      isCurrent: operation.isCurrent,
      read: async () => result,
      refresh: async () => {},
      publish,
      fail,
    });
    expect(publish).toHaveBeenCalledExactlyOnceWith(result);
    expect(fail).not.toHaveBeenCalled();
  });
});
