import { describe, expect, it } from "vitest";

import {
  activityLabel,
  appendMarketActivityPage,
  emptyMarketActivityWalk,
  marketActivityQuery,
  type MarketActivityEvent,
} from "./market-activity";

function event(eventId: string, overrides: Partial<MarketActivityEvent> = {}) {
  return {
    eventId,
    source: "opensea",
    eventType: "item_listed",
    eventFamily: "order",
    chain: "ethereum",
    eventTimestamp: "2026-09-29T08:00:00Z",
    ...overrides,
  } satisfies MarketActivityEvent;
}

describe("appendMarketActivityPage", () => {
  it("keeps the order the history served", () => {
    const first = appendMarketActivityPage(
      emptyMarketActivityWalk,
      { data: [event("a"), event("b")], nextCursor: "c1" },
      undefined,
    );
    const second = appendMarketActivityPage(
      first,
      { data: [event("c")], nextCursor: "c2" },
      "c1",
    );
    expect(second.events.map((item) => item.eventId)).toEqual(["a", "b", "c"]);
    expect(second.cursor).toBe("c2");
    expect(second.finished).toBe(false);
  });

  /**
   * The end is stated by the absent cursor, never inferred from page length. A server may serve
   * fewer rows than asked for and still have more; guessing would tell a reader the history had
   * ended when it had not.
   */
  it("ends only when the response carries no cursor", () => {
    const short = appendMarketActivityPage(
      emptyMarketActivityWalk,
      { data: [event("a")], nextCursor: "c1" },
      undefined,
    );
    expect(short.finished).toBe(false);

    const ended = appendMarketActivityPage(short, { data: [event("b")] }, "c1");
    expect(ended.finished).toBe(true);
    expect(ended.cursor).toBeUndefined();
  });

  it("treats a blank cursor as the end", () => {
    for (const nextCursor of ["", "   "]) {
      const walk = appendMarketActivityPage(
        emptyMarketActivityWalk,
        { data: [event("a")], nextCursor },
        undefined,
      );
      expect(walk.finished).toBe(true);
    }
  });

  // In a trading feed one event shown twice reads as two trades.
  it("never shows an event twice", () => {
    const first = appendMarketActivityPage(
      emptyMarketActivityWalk,
      { data: [event("a"), event("b")], nextCursor: "c1" },
      undefined,
    );
    const overlapping = appendMarketActivityPage(
      first,
      { data: [event("b"), event("c")], nextCursor: "c2" },
      "c1",
    );
    expect(overlapping.events.map((item) => item.eventId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  // A server that hands back the position just spent would otherwise be asked for it forever.
  it("stops when the cursor does not advance", () => {
    const walk = appendMarketActivityPage(
      emptyMarketActivityWalk,
      { data: [event("a")], nextCursor: "c1" },
      "c1",
    );
    expect(walk.finished).toBe(true);
    expect(walk.cursor).toBeUndefined();
    expect(walk.events).toHaveLength(1);
  });

  it("handles an empty page without losing what came before", () => {
    const first = appendMarketActivityPage(
      emptyMarketActivityWalk,
      { data: [event("a")], nextCursor: "c1" },
      undefined,
    );
    const empty = appendMarketActivityPage(first, { data: [] }, "c1");
    expect(empty.events.map((item) => item.eventId)).toEqual(["a"]);
    expect(empty.finished).toBe(true);
  });
});

describe("marketActivityQuery", () => {
  it("omits the cursor on the first page", () => {
    expect(marketActivityQuery("opensea", 25)).toBe("source=opensea&limit=25");
  });

  it("carries and escapes the cursor on later pages", () => {
    const query = marketActivityQuery("opensea", 25, "abc+def/ghi=");
    expect(query).toContain("cursor=abc%2Bdef%2Fghi%3D");
    const parsed = new URLSearchParams(query);
    expect(parsed.get("cursor")).toBe("abc+def/ghi=");
  });
});

describe("activityLabel", () => {
  it("says what the known event types are", () => {
    expect(activityLabel("item_listed")).toBe("Listed");
    expect(activityLabel("item_sold")).toBe("Sold");
  });

  // A mirror that starts carrying a new type should show that type, not be relabelled as something
  // ArtFi already understands.
  it("shows an unknown type as it arrived", () => {
    expect(activityLabel("item_teleported")).toBe("item_teleported");
  });
});
