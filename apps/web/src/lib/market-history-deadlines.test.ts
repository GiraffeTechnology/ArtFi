import { afterEach, expect, it, vi } from "vitest";
import {
  createMarketHistorySession,
  readMarketHistoryPage,
} from "./market-activity-session";
const envelope = (data: unknown[] = [], nextCursor?: string) => ({
  schemaVersion: "1",
  source: "opensea",
  custody: false,
  data,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});
const item = (id: string) => ({
  eventId: id.repeat(64),
  source: "opensea",
  eventType: "sale",
  eventFamily: "sale",
  chain: "ethereum",
  eventTimestamp: "2026-10-18T00:00:00Z",
});
const json = (body: BodyInit | null) =>
  new Response(body, { headers: { "content-type": "application/json" } });
async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("settles at the existing20s deadline even when fetch ignores abort and cancels a late body", async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = readMarketHistoryPage("", "", new AbortController().signal);
  const assertion = expect(result).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  resolve(json(new ReadableStream({ cancel })));
  await settle();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("settles on pending body timeout without awaiting nonsettling cancel", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
  const result = readMarketHistoryPage("", "", new AbortController().signal);
  const assertion = expect(result).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(20000);
  await assertion;
  await settle();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("refuses oversized history without waiting for stream cleanup", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
  await expect(
    readMarketHistoryPage("", "", new AbortController().signal),
  ).rejects.toThrow(/read limit/);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});
it("does not issue a request for an already cancelled operation or expose its abort reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error("PRIVATE_ABORT"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    readMarketHistoryPage("", "", controller.signal),
  ).rejects.toThrow(/cancelled/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("cancels a pending body immediately on deactivation without leaking cancellation reason", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
  const result = readMarketHistoryPage("", "", controller.signal);
  const assertion = expect(result).rejects.toThrow(/cancelled/);
  await settle();
  controller.abort("PRIVATE_ABORT");
  await assertion;
  await settle();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([503, 401])(
  "discards refusedHTTP%d bodies without reading or waiting",
  async (status) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream({ cancel }), { status }),
        ),
    );
    await expect(
      readMarketHistoryPage("", "", new AbortController().signal),
    ).rejects.toThrow(status === 503 ? /unavailable/ : /HTTP 401/);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it("discards an incorrect MIME response and redacts transport rejection", async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "text/html" },
        }),
      ),
  );
  await expect(
    readMarketHistoryPage("", "", new AbortController().signal),
  ).rejects.toThrow(/readable JSON/);
  expect(cancel).toHaveBeenCalledTimes(1);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("PRIVATE_NETWORK")),
  );
  await expect(
    readMarketHistoryPage("", "", new AbortController().signal),
  ).rejects.toThrow(/^The activity read is unavailable/);
});
it("retains accepted rows and opaque cursor after timeout, then manually retries the same page", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json(JSON.stringify(envelope([item("a")], "opaque+cursor="))),
    )
    .mockResolvedValueOnce(json(new ReadableStream({ cancel })))
    .mockResolvedValueOnce(json(JSON.stringify(envelope([item("b")]))));
  vi.stubGlobal("fetch", fetcher);
  const session = createMarketHistorySession((q) =>
    readMarketHistoryPage("", q, new AbortController().signal),
  );
  session.activate();
  await settle();
  expect(session.getSnapshot().events).toHaveLength(1);
  const read = session.loadMore();
  await vi.advanceTimersByTimeAsync(20000);
  await read;
  expect(session.getSnapshot()).toMatchObject({
    cursor: "opaque+cursor=",
    loading: false,
    finished: false,
  });
  expect(session.getSnapshot().events).toHaveLength(1);
  expect(session.getSnapshot().error).toMatch(/timed out/);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await session.loadMore();
  expect(fetcher.mock.calls[1]![0]).toBe(fetcher.mock.calls[2]![0]);
  expect(session.getSnapshot().events).toHaveLength(2);
  expect(session.getSnapshot().finished).toBe(true);
  session.deactivate();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not append a timed-out late fetch response after a newer retry succeeds", async () => {
  vi.useFakeTimers();
  let resolve!: (r: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(json(JSON.stringify(envelope([item("b")]))));
  vi.stubGlobal("fetch", fetcher);
  const session = createMarketHistorySession((q, s) =>
    readMarketHistoryPage("", q, s),
  );
  session.activate();
  await vi.advanceTimersByTimeAsync(20000);
  expect(session.getSnapshot().events).toHaveLength(0);
  expect(session.getSnapshot().finished).toBe(false);
  await session.loadMore();
  const current = session.getSnapshot();
  expect(current.events[0]!.eventId).toBe("b".repeat(64));
  resolve(json(JSON.stringify(envelope([item("a")], "late"))));
  await settle();
  expect(session.getSnapshot()).toBe(current);
  session.deactivate();
});
