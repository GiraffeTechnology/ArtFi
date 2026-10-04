import { describe, expect, it, vi } from "vitest";
import {
  loadPortfolioRecords,
  type PortfolioState,
} from "./portfolio-records-state";
const address = "0x1000000000000000000000000000000000000001";
const other = "0x2000000000000000000000000000000000000002";
const records = (owner = address) => ({
  address: owner,
  chainId: 560048,
  network: "hoodi",
  positions: [
    {
      assetToken: address,
      symbol: "TEST",
      balance: "2",
      updatedAt: "2026-10-02",
    },
  ],
  transactions: [],
  offers: [],
  notifications: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function load(
  request: typeof fetch,
  update: (state: PortfolioState) => void,
  signal = new AbortController().signal,
  owner = address,
) {
  return loadPortfolioRecords({
    address: owner,
    signal,
    request,
    update,
  });
}

describe("portfolio wallet context and retry", () => {
  it("loads only matching Hoodi records and clears stale state at the start", async () => {
    const update = vi.fn();
    await load(vi.fn().mockResolvedValue(Response.json(records())), update);
    expect(update.mock.calls).toEqual([
      [{ loading: true }],
      [{ loading: false, portfolio: records() }],
    ]);
  });
  it("accepts a successful empty account instead of reporting an outage", async () => {
    const update = vi.fn();
    const empty = { ...records(), positions: [], transactions: [] };
    await load(vi.fn().mockResolvedValue(Response.json(empty)), update);
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      portfolio: empty,
    });
  });
  it("discards wallet A's late body after switching to wallet B", async () => {
    const body = deferred<ReturnType<typeof records>>();
    const controller = new AbortController();
    const oldUpdate = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => body.promise });
    const oldRequest = load(request, oldUpdate, controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    controller.abort();
    const currentUpdate = vi.fn();
    await load(
      vi.fn().mockResolvedValue(Response.json(records(other))),
      currentUpdate,
      new AbortController().signal,
      other,
    );
    body.resolve(records());
    await oldRequest;
    expect(oldUpdate).toHaveBeenCalledExactlyOnceWith({ loading: true });
    expect(currentUpdate).toHaveBeenLastCalledWith({
      loading: false,
      portfolio: records(other),
    });
  });
  it("ignores errors from aborted requests", async () => {
    const controller = new AbortController();
    const update = vi.fn();
    const request = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error("old network error");
    });
    await load(request, update, controller.signal);
    expect(update).toHaveBeenCalledExactlyOnceWith({ loading: true });
  });
  it.each([
    records(other),
    { ...records(), chainId: 1 },
    { ...records(), positions: null },
  ])("does not display mismatched or incomplete data", async (value) => {
    const update = vi.fn();
    await load(vi.fn().mockResolvedValue(Response.json(value)), update);
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      error: expect.any(String),
    });
  });
  it("retries failure without retaining the previous error or fabricated empty holdings", async () => {
    const states: PortfolioState[] = [];
    const update = (state: PortfolioState) => {
      states.push(state);
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(records()));
    await load(request, update);
    expect(states.at(-1)).toEqual({
      loading: false,
      error: "Portfolio API returned 503.",
    });
    await load(request, update);
    expect(states.at(-2)).toEqual({ loading: true });
    expect(states.at(-1)).toEqual({ loading: false, portfolio: records() });
  });
  it("does not start a request for an already departed context", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    const update = vi.fn();
    await load(request, update, controller.signal);
    expect(request).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
