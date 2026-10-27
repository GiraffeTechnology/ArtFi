import { describe, expect, it, vi } from "vitest";
import type { AuctionHistoryPage } from "./auction-history-pages";
import { createAuctionHistoryPager } from "./auction-history-pager";

// Controller-only synthetic pages; the real reader has its own source tests.
function page(number = 1000): AuctionHistoryPage {
  const base = {
    version: "auction-history/1" as const,
    chainId: 560048 as const,
    market: "0x1111111111111111111111111111111111111111" as const,
    listingId: "7",
    anchorBlock: "1000",
    anchorHash: ("0x" + "1".repeat(64)) as `0x${string}`,
    blockSpan: 10,
  };
  return Object.freeze({
    market: base.market,
    listingId: "7",
    chainId: 560048,
    anchorBlock: 1000n,
    anchorHash: base.anchorHash,
    fromBlock: BigInt(number - 9),
    toBlock: BigInt(number),
    blockSpan: 10,
    entries: [],
    duplicateCount: 0,
    older: Object.freeze({ ...base, nextToBlock: String(number - 10) }),
    newer:
      number < 1000
        ? Object.freeze({ ...base, nextToBlock: String(number + 10) })
        : null,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("manual bounded auction history navigation", () => {
  it("does not auto-read and keeps only the current page during explicit older/newer navigation", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page(990))
      .mockResolvedValueOnce(page());
    const pager = createAuctionHistoryPager(read, () => 1000);
    const initial = pager.getSnapshot();
    expect(pager.getServerSnapshot()).toBe(initial);
    expect(read).not.toHaveBeenCalled();
    await pager.older();
    expect(read).not.toHaveBeenCalled();
    await pager.newest();
    const first = pager.getSnapshot().page!;
    await pager.older();
    expect(read.mock.calls[1][0]).toBe(first.older);
    const older = pager.getSnapshot().page!;
    expect(older.toBlock).toBe(990n);
    await pager.newer();
    expect(read.mock.calls[2][0]).toBe(older.newer);
    expect(pager.getSnapshot().page?.toBlock).toBe(1000n);
  });

  it("does not overlap actual pending reads or restore a hidden generation", async () => {
    const wait = deferred<AuctionHistoryPage>();
    const read = vi
      .fn()
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValue(page(990));
    const pager = createAuctionHistoryPager(read, () => 1000);
    const old = pager.newest();
    await pager.newest();
    expect(read).toHaveBeenCalledTimes(1);
    pager.setVisible(false);
    expect(read.mock.calls[0][1].aborted).toBe(true);
    pager.setVisible(true);
    await pager.newest();
    expect(read).toHaveBeenCalledTimes(1);
    expect(pager.getSnapshot()).toMatchObject({
      phase: "idle",
      pending: true,
      page: null,
    });
    wait.resolve(page());
    await old;
    expect(pager.getSnapshot()).toMatchObject({
      phase: "idle",
      pending: false,
      page: null,
    });
    await pager.newest();
    expect(pager.getSnapshot()).toMatchObject({
      phase: "ready",
      pending: false,
    });
    expect(pager.getSnapshot().page?.toBlock).toBe(990n);
  });

  it("clears failed pages, retains the last requested cursor and retries only on request", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(
        Object.assign(new Error("synthetic-source-failure"), {
          code: "SOURCE_CHANGED",
        }),
      )
      .mockResolvedValue(page(990));
    const pager = createAuctionHistoryPager(read, () => 1000);
    await pager.newest();
    const cursor = pager.getSnapshot().page!.older;
    await pager.older();
    expect(pager.getSnapshot()).toMatchObject({
      phase: "unavailable",
      page: null,
      failure: "SOURCE_CHANGED",
      pending: false,
    });
    await pager.older();
    expect(read).toHaveBeenCalledTimes(2);
    await pager.retry();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0]).toBe(cursor);
  });

  it("does not execute error-code getters or allow hostile errors to break failure handling", async () => {
    const getter = vi.fn(() => "SOURCE_CHANGED");
    const error = Object.defineProperty({}, "code", { get: getter });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("synthetic-trap");
        },
      },
    );
    for (const rejected of [
      error,
      proxy,
      { code: "untrusted-private-diagnostic" },
    ]) {
      const pager = createAuctionHistoryPager(
        vi.fn().mockRejectedValue(rejected),
      );
      await pager.newest();
      expect(pager.getSnapshot()).toMatchObject({
        phase: "unavailable",
        failure: "UNAVAILABLE",
        pending: false,
        page: null,
      });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("supports replayable visibility cleanup and rejects an invalid observation clock", async () => {
    const read = vi.fn().mockResolvedValue(page());
    const pager = createAuctionHistoryPager(read, () => Number.NaN);
    pager.setVisible(false);
    pager.setVisible(true);
    expect(read).not.toHaveBeenCalled();
    await pager.newest();
    expect(pager.getSnapshot()).toMatchObject({
      phase: "unavailable",
      page: null,
      pending: false,
    });
  });
});
