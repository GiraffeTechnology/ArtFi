import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMarketHistorySession,
  marketHistoryQuery,
  normalizeHistoryContract,
  parseMarketHistoryPage,
  readMarketHistoryPage,
} from "./market-activity-session";

const contractA = "0x" + "a".repeat(40),
  contractB = "0x" + "b".repeat(40);
function event(id: string, patch: Record<string, unknown> = {}) {
  return {
    eventId: id.repeat(64),
    source: "opensea",
    eventType: "item_sold",
    eventFamily: "sale",
    chain: "ethereum",
    eventTimestamp: "2026-10-15T10:00:00.000000Z",
    contractAddress: contractA,
    tokenId: "0",
    price: "100",
    paymentSymbol: "TEST",
    ...patch,
  };
}
function page(data: unknown[] = [], nextCursor?: string) {
  return {
    data,
    schemaVersion: "1",
    source: "opensea",
    custody: false,
    execution: "external-deeplink-only",
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("contract-filtered market history", () => {
  it.each([[[]], [[event("a")]]])(
    "clears a previous read error after successful retry",
    async (rows) => {
      let calls = 0;
      const session = createMarketHistorySession(async () => {
        if (++calls === 1) throw new Error("TEST_ONLY unavailable");
        return page(rows);
      });
      session.activate();
      await flush();
      expect(session.getSnapshot().error).toBeTruthy();
      await session.loadMore();
      expect(session.getSnapshot().error).toBeUndefined();
      expect(session.getSnapshot().events).toHaveLength(rows.length);
      expect(session.getSnapshot().finished).toBe(true);
      expect(calls).toBe(2);
      session.deactivate();
    },
  );

  it("encodes the exact supported API filter and opaque cursor", () => {
    expect(normalizeHistoryContract(" " + contractA.toUpperCase() + " ")).toBe(
      contractA,
    );
    const query = new URLSearchParams(
      marketHistoryQuery(contractA, "abc+def/ghi="),
    );
    expect(Object.fromEntries(query)).toEqual({
      source: "opensea",
      limit: "25",
      contract: contractA,
      cursor: "abc+def/ghi=",
    });
    expect(new URLSearchParams(marketHistoryQuery("")).has("contract")).toBe(
      false,
    );
    for (const value of ["0xa", contractA + "0", "x=1", "ethereum"])
      expect(() => marketHistoryQuery(value)).toThrow();
  });
  it("starts once and ignores parallel load-more clicks while a page is pending", async () => {
    const pending = deferred(),
      read = vi.fn(() => pending.promise),
      session = createMarketHistorySession(read);
    session.activate();
    session.activate();
    await Promise.all([session.loadMore(), session.loadMore()]);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(page([event("a")], "cursor1"));
    await flush();
    expect(session.getSnapshot().events).toHaveLength(1);
    expect(session.getSnapshot().finished).toBe(false);
    session.deactivate();
  });
  it("aborts and quarantines a late response and late error after changing contract", async () => {
    const old = deferred(),
      current = deferred(),
      calls: { query: string; signal: AbortSignal }[] = [];
    const session = createMarketHistorySession((query, signal) => {
      calls.push({ query, signal });
      return calls.length === 1 ? old.promise : current.promise;
    });
    session.activate();
    session.applyFilter(contractB);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(new URLSearchParams(calls[1]!.query).get("contract")).toBe(
      contractB,
    );
    expect(session.getSnapshot().events).toHaveLength(0);
    current.resolve(page([event("b", { contractAddress: contractB })]));
    await flush();
    const accepted = session.getSnapshot();
    old.reject(new Error("PRIVATE_UPSTREAM_DETAIL"));
    await flush();
    expect(session.getSnapshot()).toBe(accepted);
    expect(accepted.events[0]!.contractAddress).toBe(contractB);
    session.deactivate();
  });
  it("quarantines a late successful page from the old contract", async () => {
    const first = deferred(),
      second = deferred();
    let count = 0;
    const session = createMarketHistorySession(() =>
      ++count === 1 ? first.promise : second.promise,
    );
    session.activate();
    session.applyFilter(contractB);
    second.resolve(page([event("b", { contractAddress: contractB })]));
    await flush();
    const current = session.getSnapshot();
    first.resolve(page([event("a")], "old-cursor"));
    await flush();
    expect(session.getSnapshot()).toBe(current);
    session.deactivate();
  });
  it("does not let an invalid draft filter clear the active walk or cancel its request", async () => {
    const pending = deferred(),
      read = vi.fn((_query: string, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        return pending.promise;
      });
    const session = createMarketHistorySession(read);
    session.activate();
    const before = session.getSnapshot();
    expect(() => session.applyFilter("not-a-contract")).toThrow();
    expect(session.getSnapshot()).toBe(before);
    pending.resolve(page());
    await flush();
    expect(session.getSnapshot().finished).toBe(true);
    session.deactivate();
  });
  it("supports deactivate/reactivate without accepting a previous mount's response", async () => {
    const old = deferred(),
      current = deferred();
    const read = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const session = createMarketHistorySession(read);
    session.activate();
    session.deactivate();
    session.activate();
    expect(read).toHaveBeenCalledTimes(2);
    current.resolve(page([event("b")]));
    await flush();
    old.resolve(page([event("a")]));
    await flush();
    expect(session.getSnapshot().events.map((row) => row.eventId)).toEqual([
      "b".repeat(64),
    ]);
    session.deactivate();
  });
  it("retains a short or empty page with a cursor until the server states the end", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([], "c1"))
      .mockResolvedValueOnce(page([event("a")], "c2"))
      .mockResolvedValueOnce(page());
    const session = createMarketHistorySession(read);
    session.activate();
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      events: [],
      cursor: "c1",
      finished: false,
      started: true,
    });
    await session.loadMore();
    expect(session.getSnapshot().finished).toBe(false);
    await session.loadMore();
    expect(session.getSnapshot()).toMatchObject({
      finished: true,
      events: [expect.objectContaining({ eventId: "a".repeat(64) })],
    });
    session.deactivate();
  });
  it("deduplicates overlap but refuses conflicting data for the same event identity", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([event("a"), event("b")], "c1"))
      .mockResolvedValueOnce(page([event("b"), event("c")], "c2"))
      .mockResolvedValueOnce(page([event("c", { price: "101" }), event("d")]));
    const session = createMarketHistorySession(read);
    session.activate();
    await flush();
    await session.loadMore();
    expect(session.getSnapshot().events).toHaveLength(3);
    await session.loadMore();
    expect(session.getSnapshot().events).toHaveLength(3);
    expect(session.getSnapshot().finished).toBe(false);
    expect(session.getSnapshot().error).toMatch(
      /changed an existing event identity/,
    );
    session.deactivate();
  });
  it.each([
    ["c1", "c1"],
    ["c1", "c2", "c1"],
  ])(
    "does not report a repeated/cyclic cursor as complete: %j",
    async (...cursors) => {
      const read = vi.fn();
      cursors.forEach((cursor) =>
        read.mockResolvedValueOnce(page([event("a")], cursor)),
      );
      const session = createMarketHistorySession(read);
      session.activate();
      await flush();
      for (let i = 1; i < cursors.length; i++) await session.loadMore();
      expect(session.getSnapshot().finished).toBe(false);
      expect(session.getSnapshot().error).toMatch(
        /repeated an activity cursor/,
      );
      session.deactivate();
    },
  );
  it("keeps prior rows and cursor after a failed next page and retries the same read", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([event("a")], "c1"))
      .mockRejectedValueOnce(new Error("PRIVATE_TRACE"))
      .mockResolvedValueOnce(page([event("b")]));
    const session = createMarketHistorySession(read);
    session.activate();
    await flush();
    await session.loadMore();
    expect(session.getSnapshot()).toMatchObject({
      cursor: "c1",
      finished: false,
    });
    expect(session.getSnapshot().events).toHaveLength(1);
    expect(session.getSnapshot().error).not.toMatch(/PRIVATE_TRACE/);
    await session.loadMore();
    expect(read.mock.calls[1]![0]).toBe(read.mock.calls[2]![0]);
    expect(session.getSnapshot().events).toHaveLength(2);
    expect(session.getSnapshot().finished).toBe(true);
    session.deactivate();
  });
  it("clears prior pages and old cursors on refresh or clearing the contract filter", async () => {
    const read = vi.fn().mockResolvedValue(page([event("a")], "c1"));
    const session = createMarketHistorySession(read);
    session.applyFilter(contractA);
    session.activate();
    await flush();
    session.refresh();
    expect(session.getSnapshot().events).toHaveLength(0);
    await flush();
    expect(new URLSearchParams(read.mock.calls[1]![0]).has("cursor")).toBe(
      false,
    );
    session.applyFilter("");
    expect(session.getSnapshot().events).toHaveLength(0);
    await flush();
    expect(new URLSearchParams(read.mock.calls[2]![0]).has("contract")).toBe(
      false,
    );
    session.deactivate();
  });
});

describe("attributed history page validation", () => {
  it("copies only display fields and keeps arbitrary raw payload out of browser state", () => {
    const source = event("a", { payload: { upstream: "NOT_COPIED" } });
    const parsed = parseMarketHistoryPage(page([source]), contractA);
    expect(parsed.events[0]).not.toHaveProperty("payload");
    expect(Object.isFrozen(parsed.events[0])).toBe(true);
    source.price = "999";
    expect(parsed.events[0]!.price).toBe("100");
  });
  it("refuses missing envelopes, false empties, foreign sources/contracts and numeric IDs", () => {
    for (const raw of [
      { data: [] },
      page().data,
      { ...page(), custody: true },
      { ...page(), source: "foreign" },
      page([event("a", { source: "foreign" })]),
      page([event("a", { contractAddress: contractB })]),
      page([event("a", { tokenId: 0 })]),
      page([event("a", { eventTimestamp: "invalid" })]),
      page([event("a", { eventId: "short" })]),
      page([event("a", { eventFamily: "unknown" })]),
      page([event("a", { price: (1n << 256n).toString() })]),
      { ...page(), nextCursor: null },
      { ...page(), nextCursor: "" },
      page([event("a")], " cursor "),
    ])
      expect(() => parseMarketHistoryPage(raw, contractA)).toThrow();
  });
  it("rejects a partially invalid page and reversed chronology as a whole", async () => {
    const read = vi.fn().mockResolvedValue(page([event("a"), {}]));
    const session = createMarketHistorySession(read);
    session.activate();
    await flush();
    expect(session.getSnapshot().events).toHaveLength(0);
    expect(session.getSnapshot().finished).toBe(false);
    expect(session.getSnapshot().error).toBeTruthy();
    expect(() =>
      parseMarketHistoryPage(
        page([
          event("a", { eventTimestamp: "2026-10-15T09:00:00Z" }),
          event("b"),
        ]),
        "",
      ),
    ).toThrow();
    expect(() =>
      parseMarketHistoryPage(
        page(Array.from({ length: 26 }, () => event("a"))),
        "",
      ),
    ).toThrow();
    session.deactivate();
  });
});

describe("bounded activity transport", () => {
  it("uses no-store GET and a cancellation signal", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page()), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await readMarketHistoryPage(
        "",
        marketHistoryQuery(""),
        new AbortController().signal,
      ),
    ).toEqual(page());
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });
  it("does not convert HTTP failures, wrong MIME, interrupted bodies or invalid UTF-8 into empty pages", async () => {
    const responses = [
      new Response("PRIVATE_DETAIL", { status: 503 }),
      new Response("{}", { headers: { "Content-Type": "text/html" } }),
      new Response(new Uint8Array([255]), {
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("PRIVATE_STREAM"));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ];
    for (const response of responses) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        readMarketHistoryPage("", "", new AbortController().signal),
      ).rejects.not.toThrow(/PRIVATE_/);
    }
  });
  it("rejects oversized streamed data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(" ".repeat(2 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(
      readMarketHistoryPage("", "", new AbortController().signal),
    ).rejects.toThrow(/read limit/);
  });
  it("bounds an unavailable request and clears its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener(
              "abort",
              () => reject(new Error("ABORTED")),
              { once: true },
            ),
          ),
      ),
    );
    const promise = readMarketHistoryPage("", "", new AbortController().signal);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
