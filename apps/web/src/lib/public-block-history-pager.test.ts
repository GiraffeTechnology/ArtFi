import { describe, expect, it, vi } from "vitest";
import { createPublicBlockHistoryPager } from "./public-block-history-pager";

// Different public navigation shapes must retain their own exact cursor object.
describe("shared public-history navigation", () => {
  it("retains a structured discovery cursor across an explicit failed-page retry", async () => {
    const cursor = Object.freeze({
      version: "auction-discovery/1",
      windowTo: "20000",
      direction: "older",
      boundary: Object.freeze({ listingId: "51" }),
    });
    type Page = { older: typeof cursor | null; newer: typeof cursor | null };
    const read = vi
      .fn<(next: typeof cursor | null, signal: AbortSignal) => Promise<Page>>()
      .mockResolvedValueOnce({ older: cursor, newer: null })
      .mockRejectedValueOnce(
        Object.assign(new Error("synthetic"), { code: "SOURCE_CHANGED" }),
      )
      .mockResolvedValueOnce({ older: null, newer: cursor });
    const pager = createPublicBlockHistoryPager(read, () => 1000);
    expect(read).not.toHaveBeenCalled();
    await pager.newest();
    await pager.older();
    expect(pager.getSnapshot()).toMatchObject({
      phase: "unavailable",
      page: null,
      failure: "SOURCE_CHANGED",
    });
    await pager.newer();
    expect(read).toHaveBeenCalledTimes(2);
    await pager.retry();
    expect(read.mock.calls[1][0]).toBe(cursor);
    expect(read.mock.calls[2][0]).toBe(cursor);
    expect(pager.getSnapshot().page?.newer).toBe(cursor);
  });

  it("drains a hidden read before another request without restoring its obsolete page", async () => {
    type Page = { older: string | null; newer: string | null };
    let finish!: (value: Page) => void;
    const pending = new Promise<Page>((resolve) => {
      finish = resolve;
    });
    const read = vi
      .fn<(next: string | null, signal: AbortSignal) => Promise<Page>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ older: null, newer: "newer" });
    const pager = createPublicBlockHistoryPager(read);
    const active = pager.newest();
    pager.setVisible(false);
    pager.setVisible(true);
    expect(read.mock.calls[0][1].aborted).toBe(true);
    await pager.newest();
    expect(read).toHaveBeenCalledTimes(1);
    finish({ older: "obsolete", newer: null });
    await active;
    expect(pager.getSnapshot()).toMatchObject({
      phase: "idle",
      pending: false,
      page: null,
    });
    await pager.newest();
    expect(read).toHaveBeenCalledTimes(2);
    expect(pager.getSnapshot().page?.newer).toBe("newer");
  });
});
