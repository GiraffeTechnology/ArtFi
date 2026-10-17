import { describe, expect, it, vi } from "vitest";
import { parsePortfolioRecords } from "./portfolio-records-contract";
import { loadPortfolioRecords } from "./portfolio-records-state";
const address = "0x1000000000000000000000000000000000000001";
const token = "0x2000000000000000000000000000000000000002";
const payment = "0x3000000000000000000000000000000000000003";
const time = "2026-10-18T00:00:00Z";
function event(status = "confirmed", suffix = "a") {
  const transactionHash = `0x${suffix.repeat(64)}`;
  return {
    id: `560048:${transactionHash}:1`,
    transactionHash,
    logIndex: 1,
    contractAddress: token,
    eventName: "IntentFilled",
    blockNumber: 20,
    status,
    observedAt: time,
  };
}
function records() {
  return {
    address,
    chainId: 560048,
    network: "hoodi",
    positions: [
      {
        assetToken: token,
        symbol: "TEST",
        balance: "900719925474099300000001",
        updatedAt: time,
      },
    ],
    transactions: [event()],
    offers: [],
    notifications: [
      {
        ...event(),
        message: "IntentFilled is confirmed in the indexed chain history.",
      },
    ],
    performance: {
      status: "known_for_indexed_history",
      method: "fifo",
      scope: "confirmed_indexed_fraction_trades",
      unmappedTradeCount: 0,
      pendingEventCount: 0,
      reasons: [],
      items: [
        {
          assetToken: token,
          paymentToken: payment,
          confirmedQuantity: "900719925474099300000001",
          costBasis: "1801439850948198600000002",
          realizedPnl: "-1",
          status: "known",
          buyCount: 1,
          sellCount: 1,
          reasons: [],
        },
      ],
    },
  };
}
describe("complete rendered portfolio contract", () => {
  it("keeps exact large integers, negative P&L and matching event provenance", () => {
    expect(parsePortfolioRecords(records(), address)).toEqual(records());
  });
  it("retains negative incomplete indexed balances and unknown basis without inventing zeros", () => {
    const value = records();
    value.positions[0].balance = "-2";
    const result = parsePortfolioRecords(
      {
        ...value,
        performance: {
          ...value.performance,
          status: "unknown",
          items: [
            {
              ...value.performance.items[0],
              status: "unknown",
              costBasis: null,
              realizedPnl: null,
            },
          ],
        },
      },
      address,
    );
    expect(result.positions[0].balance).toBe("-2");
    expect(result.performance!.items[0].costBasis).toBeNull();
  });
  it("preserves a successful empty account and legacy missing performance as missing", () => {
    const value = {
      ...records(),
      positions: [],
      transactions: [],
      notifications: [],
    };
    const { performance: _, ...legacy } = value;
    expect(parsePortfolioRecords(legacy, address)).toEqual(legacy);
    expect(parsePortfolioRecords(value, address).positions).toEqual([]);
  });
  it.each([
    null,
    { ...records().positions[0], balance: 2 },
    { ...records().positions[0], balance: "1.5" },
    { ...records().positions[0], balance: "01" },
    { ...records().positions[0], balance: "-0" },
    { ...records().positions[0], assetToken: "invalid" },
    { ...records().positions[0], symbol: null },
    { ...records().positions[0], updatedAt: "2026-02-30T00:00:00Z" },
  ])("rejects a malformed position before React sees it", (row) => {
    expect(() =>
      parsePortfolioRecords({ ...records(), positions: [row] }, address),
    ).toThrow("incomplete");
  });
  it.each([
    { ...event(), id: "other-event" },
    { ...event(), logIndex: -1 },
    { ...event(), logIndex: 1.5 },
    { ...event(), blockNumber: Number.MAX_SAFE_INTEGER + 1 },
    { ...event(), transactionHash: "0x12" },
    { ...event(), contractAddress: "invalid" },
    { ...event(), status: "settled" },
    null,
  ])("rejects malformed indexed event evidence", (row) => {
    expect(() =>
      parsePortfolioRecords({ ...records(), transactions: [row] }, address),
    ).toThrow("incomplete");
  });
  it.each([
    { ...records().performance.items[0], buyCount: -1 },
    { ...records().performance.items[0], sellCount: 1.5 },
    { ...records().performance.items[0], paymentToken: "invalid" },
    { ...records().performance.items[0], confirmedQuantity: null },
    { ...records().performance.items[0], costBasis: "1.5" },
    null,
  ])("does not present invalid or incomplete P&L as known", (row) => {
    const value = records();
    expect(() =>
      parsePortfolioRecords(
        { ...value, performance: { ...value.performance, items: [row] } },
        address,
      ),
    ).toThrow("incomplete");
  });
  it("rejects duplicates in each asset/event projection", () => {
    const value = records();
    for (const key of ["positions", "transactions", "notifications"] as const)
      expect(() =>
        parsePortfolioRecords(
          { ...value, [key]: [...value[key], ...value[key]] },
          address,
        ),
      ).toThrow("incomplete");
    expect(() =>
      parsePortfolioRecords(
        {
          ...value,
          performance: {
            ...value.performance,
            items: [...value.performance.items, ...value.performance.items],
          },
        },
        address,
      ),
    ).toThrow("incomplete");
  });
  it("rejects contradictory same-event history and alerts or mismatched confirmation text", () => {
    expect(() =>
      parsePortfolioRecords(
        {
          ...records(),
          notifications: [
            {
              ...event("removed"),
              message:
                "IntentFilled was removed from the canonical chain. Any previous confirmation no longer applies.",
            },
          ],
        },
        address,
      ),
    ).toThrow("incomplete");
    expect(() =>
      parsePortfolioRecords(
        {
          ...records(),
          notifications: [{ ...event(), message: "Confirmed forever" }],
        },
        address,
      ),
    ).toThrow("incomplete");
  });
  it("allows different valid windows and matching removed evidence", () => {
    expect(
      parsePortfolioRecords(
        {
          ...records(),
          notifications: [
            {
              ...event("pending", "b"),
              message:
                "IntentFilled was observed for this wallet. Confirmation is pending.",
            },
          ],
        },
        address,
      ).notifications,
    ).toHaveLength(1);
    expect(
      parsePortfolioRecords(
        {
          ...records(),
          transactions: [event("removed")],
          notifications: [
            {
              ...event("removed"),
              message:
                "IntentFilled was removed from the canonical chain. Any previous confirmation no longer applies.",
            },
          ],
        },
        address,
      ).transactions[0].status,
    ).toBe("removed");
  });
  it("projects fresh rendered objects and does not carry unknown root fields into React state", () => {
    const value = records(),
      parsed = parsePortfolioRecords(
        { ...value, unusedField: "ignored" },
        address,
      );
    value.positions[0].balance = "1";
    value.performance.items[0].realizedPnl = "100";
    expect(parsed.positions[0].balance).toBe("900719925474099300000001");
    expect(parsed.performance!.items[0].realizedPnl).toBe("-1");
    expect(parsed).not.toHaveProperty("unusedField");
  });
  it("maps a body/transport decoder diagnostic to a bounded unavailable state", async () => {
    const update = vi.fn();
    await loadPortfolioRecords({
      address,
      signal: new AbortController().signal,
      update,
      request: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("DO_NOT_EXPOSE_DECODER_DETAIL");
        },
      }),
    });
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      error: "Portfolio records are unavailable.",
    });
    expect(JSON.stringify(update.mock.calls)).not.toContain("DO_NOT_EXPOSE");
  });
});
