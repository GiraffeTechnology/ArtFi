import { describe, expect, it } from "vitest";
import type { PortfolioEntry } from "./portfolio-records-state";
import {
  INITIAL_PORTFOLIO_HISTORY_FILTER,
  projectPortfolioHistory,
} from "./portfolio-history";

function entry(
  index: number,
  status: PortfolioEntry["status"] = "confirmed",
): PortfolioEntry {
  return {
    id: `560048:event:${index}`,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    contractAddress: `0x${"12".repeat(20)}`,
    eventName: index % 2 ? "Transfer" : "IntentFilled",
    blockNumber: Math.floor(index / 3),
    logIndex: index,
    status,
    observedAt: "2026-10-16T12:00:00Z",
  };
}
const filter = (values = {}) => ({
  ...INITIAL_PORTFOLIO_HISTORY_FILTER,
  ...values,
});

describe("loaded portfolio history projection", () => {
  it("pages by canonical block and log order without mutating the response", () => {
    const records = Array.from({ length: 23 }, (_, index) => entry(index));
    const before = structuredClone(records);
    const first = projectPortfolioHistory(records, filter());
    expect(first.entries.map((item) => item.logIndex)).toEqual([
      22, 21, 20, 19, 18, 17, 16, 15, 14, 13,
    ]);
    expect([first.first, first.last, first.pages, first.totalLoaded]).toEqual([
      1, 10, 3, 23,
    ]);
    const last = projectPortfolioHistory(records, filter({ page: 3 }));
    expect(last.entries.map((item) => item.logIndex)).toEqual([2, 1, 0]);
    expect([last.first, last.last]).toEqual([21, 23]);
    expect(records).toEqual(before);
  });
  it("combines event and status filters without turning removed logs into confirmation", () => {
    const removed = entry(1, "removed");
    const view = projectPortfolioHistory(
      [entry(0), removed, entry(3, "pending")],
      filter({ status: "removed", eventName: "Transfer" }),
    );
    expect(view.entries).toEqual([removed]);
    expect(view.totalMatching).toBe(1);
    expect(view.totalLoaded).toBe(3);
    expect(view.eventNames).toEqual(["IntentFilled", "Transfer"]);
  });
  it("supports ascending order and distinguishes no match from no loaded history", () => {
    const records = [entry(4), entry(2), entry(3)];
    expect(
      projectPortfolioHistory(
        records,
        filter({ direction: "oldest" }),
      ).entries.map((item) => item.logIndex),
    ).toEqual([2, 3, 4]);
    const none = projectPortfolioHistory(
      records,
      filter({ eventName: "BidPlaced" }),
    );
    expect([
      none.totalLoaded,
      none.totalMatching,
      none.first,
      none.last,
      none.page,
      none.pages,
    ]).toEqual([3, 0, 0, 0, 1, 1]);
    expect(projectPortfolioHistory([], filter()).totalLoaded).toBe(0);
  });
  it("clamps pages when refresh or reorg removes loaded records", () => {
    const view = projectPortfolioHistory([entry(0)], filter({ page: 99 }));
    expect(view.page).toBe(1);
    expect(view.entries).toHaveLength(1);
  });
  it("has a deterministic tie break and retains full source identifiers", () => {
    const a = entry(1),
      b = { ...entry(2), blockNumber: a.blockNumber, logIndex: a.logIndex };
    const view = projectPortfolioHistory(
      [a, b],
      filter({ direction: "oldest" }),
    );
    expect(view.entries.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(view.entries[0].transactionHash).toBe(a.transactionHash);
  });
  it.each([
    { page: 0 },
    { page: 1.5 },
    { status: "success" },
    { direction: "random" },
    { eventName: "<script>" },
  ])("refuses invalid filter %j", (invalid) => {
    expect(() =>
      projectPortfolioHistory([entry(0)], filter(invalid) as never),
    ).toThrow("Indexed history is unavailable.");
  });
  it.each([
    { status: "success" },
    { blockNumber: -1 },
    { logIndex: NaN },
    { transactionHash: "0x1234" },
    { observedAt: "unknown" },
    { eventName: "<script>" },
    { contractAddress: "private-host" },
  ])(
    "refuses malformed loaded record %j without displaying a partial page",
    (invalid) => {
      expect(() =>
        projectPortfolioHistory(
          [entry(0), { ...entry(1), ...invalid }] as never,
          filter(),
        ),
      ).toThrow("Indexed history is unavailable.");
    },
  );
  it("refuses duplicate event identity", () => {
    const original = entry(0);
    expect(() =>
      projectPortfolioHistory(
        [original, { ...original, status: "removed" }],
        filter(),
      ),
    ).toThrow();
  });
});
