import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPortfolioRecords } from "./portfolio-records-state";
import {
  portfolioRequestTimeoutMs,
  maximumPortfolioResponseBytes,
} from "./portfolio-request";
const address = "0x1000000000000000000000000000000000000001";
const records = () => ({
  address,
  chainId: 560048,
  network: "hoodi",
  positions: [],
  transactions: [],
  offers: [],
  notifications: [],
});
function start(request: typeof fetch, controller = new AbortController()) {
  const update = vi.fn();
  const pending = loadPortfolioRecords({
    address,
    signal: controller.signal,
    request,
    update,
  });
  return { update, pending, controller };
}
const unavailable = (update: ReturnType<typeof vi.fn>) =>
  expect(update).toHaveBeenLastCalledWith({
    loading: false,
    error: expect.any(String),
  });
afterEach(() => vi.useRealTimers());
describe("finite portfolio client response", () => {
  it("preserves the existing session request flags and canonical data", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(records()));
    const { update, pending } = start(request);
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      portfolio: records(),
    });
  });
  it.each(["streamed", "declared", "invalid-utf8"])(
    "portfolio-read regression rejects %s response before publishing records",
    async (mode) => {
      let response: Response;
      if (mode === "streamed")
        response = Response.json({
          ...records(),
          extra: "x".repeat(maximumPortfolioResponseBytes),
        });
      else if (mode === "declared")
        response = Response.json(records(), {
          headers: {
            "content-length": String(maximumPortfolioResponseBytes + 1),
          },
        });
      else {
        const prefix = JSON.stringify({
          ...records(),
          positions: [
            {
              assetToken: address,
              symbol: "REPLACE",
              balance: "1",
              updatedAt: "2026-10-20T00:00:00Z",
            },
          ],
        });
        const pieces = prefix.split("REPLACE");
        const before = new TextEncoder().encode(pieces[0]);
        const after = new TextEncoder().encode(pieces[1]);
        const bytes = new Uint8Array(before.length + 1 + after.length);
        bytes.set(before);
        bytes[before.length] = 255;
        bytes.set(after, before.length + 1);
        response = new Response(bytes);
      }
      const { update, pending } = start(vi.fn().mockResolvedValue(response));
      await pending;
      unavailable(update);
      expect(update.mock.calls.some(([state]) => state.portfolio)).toBe(false);
    },
  );
  it.each(["fetch", "body"])(
    "ends loading when %s ignores cancellation",
    async (phase) => {
      vi.useFakeTimers();
      const request = vi.fn().mockImplementation(() =>
        phase === "fetch"
          ? new Promise(() => {})
          : Promise.resolve(
              new Response(
                new ReadableStream({
                  start() {},
                  cancel() {
                    return new Promise(() => {});
                  },
                }),
              ),
            ),
      );
      const { update, pending } = start(request);
      await vi.advanceTimersByTimeAsync(portfolioRequestTimeoutMs);
      await pending;
      expect(update).toHaveBeenLastCalledWith({
        loading: false,
        error: "Portfolio records timed out. Retry indexed records.",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("releases a cancelled wallet load even when fetch never returns", async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { update, pending, controller } = start(request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    await pending;
    expect(update).toHaveBeenCalledExactlyOnceWith({ loading: true });
  });
  it("discards a late response after the deadline without showing its data", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const { update, pending } = start(request);
    await vi.advanceTimersByTimeAsync(portfolioRequestTimeoutMs);
    await pending;
    const calls = update.mock.calls.length;
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(calls);
    expect(update.mock.calls.some(([state]) => state.portfolio)).toBe(false);
  });
  it("does not wait for refusal-body cancellation or expose its contents", async () => {
    const response = new Response(
      new ReadableStream({
        start() {},
        cancel() {
          return new Promise(() => {});
        },
      }),
      { status: 403 },
    );
    const { update, pending } = start(vi.fn().mockResolvedValue(response));
    await pending;
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      error: "Portfolio API returned 403.",
    });
  });
  it("retains one deadline across response arrival and stalled body", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const { update, pending } = start(request);
    await vi.advanceTimersByTimeAsync(portfolioRequestTimeoutMs - 1);
    finish(new Response(new ReadableStream({ start() {} })));
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      error: "Portfolio records timed out. Retry indexed records.",
    });
  });
  it("accepts a UTF-8 character split across actual stream chunks", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...records(),
        positions: [
          {
            assetToken: address,
            symbol: "作品",
            balance: "2",
            updatedAt: "2026-10-20T00:00:00Z",
          },
        ],
      }),
    );
    const position = bytes.indexOf(228);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, position + 1));
          controller.enqueue(bytes.slice(position + 1));
          controller.close();
        },
      }),
    );
    const { update, pending } = start(vi.fn().mockResolvedValue(response));
    await pending;
    expect(update.mock.calls.at(-1)![0].portfolio.positions[0].symbol).toBe(
      "作品",
    );
  });
  it("hides private transport diagnostics", async () => {
    const { update, pending } = start(
      vi.fn().mockRejectedValue(new Error("internal credential diagnostic")),
    );
    await pending;
    expect(update).toHaveBeenLastCalledWith({
      loading: false,
      error: "Portfolio records are unavailable.",
    });
  });
});
