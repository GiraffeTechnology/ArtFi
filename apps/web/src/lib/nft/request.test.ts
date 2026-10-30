import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maximumNftResponseBytes,
  nftRequestTimeoutMs,
  NftAPIError,
  requestNftAPI,
} from "./request";

const transport = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
);
const encoder = new TextEncoder();
beforeEach(() => {
  transport.mockReset();
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function response(bytes: Uint8Array[], init?: ResponseInit) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of bytes) controller.enqueue(part);
        controller.close();
      },
    }),
    init,
  );
}
function expectTypedFailure(work: Promise<unknown>, status: number) {
  return expect(work).rejects.toMatchObject({ name: "NftAPIError", status });
}
describe("native NFT request response boundary", () => {
  it("retains the original same-origin GET URL and exact string identities", async () => {
    const token = ((1n << 256n) - 1n).toString();
    transport.mockResolvedValueOnce(
      Response.json({ tokenId: token, nested: { retained: true } }),
    );
    const result = await requestNftAPI(
      "detail",
      undefined,
      new URLSearchParams({ tokenId: token }),
    );
    expect(result).toEqual({ tokenId: token, nested: { retained: true } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      `/api/nft/detail?tokenId=${token}`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      }),
    );
  });
  it("retains a POST operation ID without retrying or changing its payload", async () => {
    const body = {
      operationId: "operation_original_001",
      transactionHash: "0x" + "ab".repeat(32),
    };
    transport.mockResolvedValueOnce(Response.json({ status: "pending" }));
    await expect(requestNftAPI("broadcast", body)).resolves.toEqual({
      status: "pending",
    });
    expect(transport).toHaveBeenCalledWith(
      "/api/nft/broadcast",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts a complete object at the byte boundary", async () => {
    const body = '{"value":"' + "a".repeat(maximumNftResponseBytes - 12) + '"}';
    expect(encoder.encode(body)).toHaveLength(maximumNftResponseBytes);
    transport.mockResolvedValueOnce(new Response(body));
    const result = await requestNftAPI<{ value: string }>("catalog");
    expect(result.value).toHaveLength(maximumNftResponseBytes - 12);
  });
  it("rejects declared oversized response before consuming it", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    transport.mockResolvedValueOnce(
      new Response(stream, {
        headers: { "content-length": String(maximumNftResponseBytes + 1) },
      }),
    );
    await expectTypedFailure(
      requestNftAPI("prepare", { operationId: "operation_original_001" }),
      502,
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streamed response despite a small declared length", async () => {
    transport.mockResolvedValueOnce(
      response(
        [
          encoder.encode('{"value":"'),
          new Uint8Array(maximumNftResponseBytes).fill(97),
          encoder.encode('"}'),
        ],
        { headers: { "content-length": "1" } },
      ),
    );
    await expectTypedFailure(
      requestNftAPI("sign", { operationId: "operation_original_001" }),
      502,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid", "-1", "1.5"])(
    "rejects malformed declared length %s",
    async (length) => {
      transport.mockResolvedValueOnce(
        new Response('{"ok":true}', { headers: { "content-length": length } }),
      );
      await expectTypedFailure(requestNftAPI("status"), 502);
    },
  );
  it("rejects invalid UTF-8 instead of accepting replacement characters", async () => {
    transport.mockResolvedValueOnce(
      response([
        encoder.encode('{"name":"'),
        new Uint8Array([0xc3, 0x28]),
        encoder.encode('"}'),
      ]),
    );
    await expectTypedFailure(requestNftAPI("detail"), 502);
  });
  it("decodes a valid multibyte character split across chunks", async () => {
    transport.mockResolvedValueOnce(
      response([
        encoder.encode('{"name":"'),
        new Uint8Array([0xe4]),
        new Uint8Array([0xbd, 0xa0]),
        encoder.encode('"}'),
      ]),
    );
    await expect(requestNftAPI("detail")).resolves.toEqual({ name: "你" });
  });
  it.each(["null", "[]", "1", '"text"', '{"ok":true}{}', ""])(
    "rejects a non-object or malformed envelope %s",
    async (body) => {
      transport.mockResolvedValueOnce(new Response(body));
      await expectTypedFailure(requestNftAPI("status"), 502);
    },
  );
  it.each([401, 403])(
    "keeps authentication failures typed with malformed bodies: %s",
    async (status) => {
      transport.mockResolvedValueOnce(
        new Response("<gateway-private-detail>", { status }),
      );
      const error = await requestNftAPI("owned").catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(NftAPIError);
      expect(error).toMatchObject({ status });
      expect(String(error)).not.toContain("gateway-private-detail");
    },
  );
  it("retains a bounded supported action error", async () => {
    transport.mockResolvedValueOnce(
      Response.json({ detail: "The order expired." }, { status: 409 }),
    );
    await expect(requestNftAPI("review")).rejects.toMatchObject({
      status: 409,
      message: "The order expired.",
    });
  });
  it.each(["x".repeat(513), "internal\ntrace"])(
    "does not echo an unbounded or control-bearing error",
    async (detail) => {
      transport.mockResolvedValueOnce(
        Response.json({ detail }, { status: 503 }),
      );
      const error = await requestNftAPI("catalog").catch(
        (value: unknown) => value,
      );
      expect(error).toMatchObject({ status: 503 });
      expect(String(error)).not.toContain(detail);
    },
  );
  it("bounds a fetch which ignores abort without replay", async () => {
    vi.useFakeTimers();
    transport.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const work = requestNftAPI("prepare", {
      operationId: "operation_original_001",
    });
    const failure = expectTypedFailure(work, 504);
    await vi.advanceTimersByTimeAsync(nftRequestTimeoutMs + 1);
    await failure;
    expect(transport).toHaveBeenCalledTimes(1);
    const init = (
      transport.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(init.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled body even if cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    transport.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })),
    );
    const work = requestNftAPI("broadcast", {
      operationId: "operation_original_001",
    });
    const failure = expectTypedFailure(work, 504);
    await vi.advanceTimersByTimeAsync(nftRequestTimeoutMs + 1);
    await failure;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the deadline classification when fetch observes the abort", async () => {
    vi.useFakeTimers();
    transport.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const failure = expectTypedFailure(
      requestNftAPI("prepare", { operationId: "operation_original_001" }),
      504,
    );
    await vi.advanceTimersByTimeAsync(nftRequestTimeoutMs + 1);
    await failure;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not expose a raw fetch failure or retry the original request", async () => {
    transport.mockRejectedValueOnce(new Error("internal-host-secret"));
    const error = await requestNftAPI("sign", {
      operationId: "operation_original_001",
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain("internal-host-secret");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
