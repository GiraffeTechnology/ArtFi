import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuctionObserver } from "./auction-observer";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
describe("visible sequential auction reads", () => {
  it("runs only after activation and schedules the next read after completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const pending = deferred<string>();
    const read = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue("next");
    const observer = createAuctionObserver(read);
    expect(read).not.toHaveBeenCalled();
    observer.setActive(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    await observer.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve("first");
    await Promise.resolve();
    await Promise.resolve();
    expect(observer.getSnapshot()).toMatchObject({
      phase: "ready",
      value: "first",
    });
    await vi.advanceTimersByTimeAsync(11999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    observer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards the hidden generation and resumes without overlapping its pending read", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const read = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue("fresh");
    const observer = createAuctionObserver(read);
    observer.setActive(true);
    observer.setActive(false);
    expect(observer.getSnapshot()).toMatchObject({
      phase: "paused",
      value: null,
    });
    observer.setActive(true);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve("late-hidden");
    await Promise.resolve();
    await Promise.resolve();
    expect(observer.getSnapshot().value).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(observer.getSnapshot()).toMatchObject({
      phase: "ready",
      value: "fresh",
    });
    observer.dispose();
  });
  it("can repeat visibility effect setup/cleanup without losing the observer", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue("current");
    const observer = createAuctionObserver(read);
    observer.setActive(true);
    observer.setActive(false);
    observer.setActive(true);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getSnapshot()).toMatchObject({
      phase: "ready",
      value: "current",
    });
    observer.dispose();
  });
  it("removes stale state on source failure and allows a later read-only recovery", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce("old")
      .mockRejectedValueOnce(new Error("reorg"))
      .mockResolvedValueOnce("new");
    const observer = createAuctionObserver(read);
    observer.setActive(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(observer.getSnapshot().value).toBe("old");
    await observer.refresh();
    expect(observer.getSnapshot()).toMatchObject({
      phase: "unavailable",
      value: null,
      observedAt: null,
    });
    await observer.refresh();
    expect(observer.getSnapshot()).toMatchObject({
      phase: "ready",
      value: "new",
    });
    expect(read).toHaveBeenCalledTimes(3);
    observer.dispose();
  });
  it("never resurrects disposed data or timers when the last await completes", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const observer = createAuctionObserver(() => pending.promise);
    const listener = vi.fn();
    observer.subscribe(listener);
    observer.setActive(true);
    observer.dispose();
    listener.mockClear();
    pending.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(observer.getSnapshot().value).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    observer.setActive(true);
    expect(observer.getSnapshot().phase).toBe("paused");
  });
});
