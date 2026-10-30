import { afterEach, describe, expect, it, vi } from "vitest";
import { maximumUserJSONBytes, readUserJSON } from "./user-auth-json";
import { browserSessionAPI, ClientSessionError } from "./user-session-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const encoder = new TextEncoder();
function streamed(
  bytes: Uint8Array,
  width = 1,
  headers: Record<string, string> = {},
) {
  let offset = 0;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + width));
        offset = Math.min(bytes.length, offset + width);
      },
      cancel,
    }),
    { headers },
  );
  return { response, cancel };
}
describe("shared strict authentication JSON reader", () => {
  it("retains UTF-8 code points split across chunks without unbounded text/json helpers", async () => {
    const value = { message: "English € 漢字" };
    const { response } = streamed(encoder.encode(JSON.stringify(value)));
    const text = vi.spyOn(response, "text"),
      json = vi.spyOn(response, "json");
    expect(await readUserJSON(response, { timeoutMs: 1000 })).toEqual(value);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
  it.each([undefined, "1"])(
    "counts actual UTF8 bytes with declared length %s",
    async (length) => {
      const value = JSON.stringify({ message: "界".repeat(6000) });
      expect(value.length).toBeLessThan(maximumUserJSONBytes);
      const { response, cancel } = streamed(
        encoder.encode(value),
        1024,
        length ? { "content-length": length } : {},
      );
      await expect(
        readUserJSON(response, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ reason: "too-large" });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each(["99999999999999999999", "invalid"])(
    "refuses invalid or oversized declared length %s",
    async (length) => {
      const { response, cancel } = streamed(encoder.encode("{}"), 1, {
        "content-length": length,
      });
      await expect(
        readUserJSON(response, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ reason: "too-large" });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [123, 34, 118, 34, 58, 34, 0xc3, 0x28, 34, 125],
    [123, 34, 118, 34, 58, 34, 0xe2],
  ])(
    "rejects invalid or truncated UTF8 rather than replacing bytes",
    async (...values) => {
      const { response } = streamed(new Uint8Array(values));
      await expect(
        readUserJSON(response, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ reason: "invalid" });
    },
  );
  it("settles its deadline even if underlying cancellation never resolves", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream({ pull: () => new Promise(() => {}), cancel }),
    );
    const result = expect(
      readUserJSON(response, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors an external abort and cancels the body without waiting for cancellation", async () => {
    const control = new AbortController(),
      cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream({ pull: () => new Promise(() => {}), cancel }),
    );
    const result = expect(
      readUserJSON(response, { signal: control.signal, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ reason: "aborted" });
    control.abort();
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("browser response uncertainty", () => {
  it.each(["verify", "refresh", "challenge", "logout"] as const)(
    "retains possible cookie mutation for unreadable %s response",
    async (action) => {
      const { response } = streamed(
        encoder.encode(JSON.stringify({ message: "界".repeat(6000) })),
        1024,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      await expect(browserSessionAPI(action)).rejects.toMatchObject({
        status: 503,
        cookiesMayHaveChanged: true,
      });
    },
  );
  it("keeps session-read failure distinct from a possible cookie mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{broken")),
    );
    await expect(browserSessionAPI("session")).rejects.toMatchObject({
      status: 503,
      cookiesMayHaveChanged: false,
    });
  });
  it("returns a known HTTP rejection without waiting for a hostile cancellation promise", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), { status: 401 }),
      ),
    );
    const result = browserSessionAPI("verify").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const error = await result;
    expect(error).toBeInstanceOf(ClientSessionError);
    expect(error).toMatchObject({ status: 401, cookiesMayHaveChanged: false });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
