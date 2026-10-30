import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharityHolderAsset } from "./charity-assets";
import {
  fetchHolderObject,
  maxHolderObjectBytes,
  maxHolderReadDurationMs,
  type HolderObjectConfig,
} from "./charity-object-store";

const watermarked = new TextEncoder().encode(
  "isolated-watermarked-holder-copy",
);
const master = new TextEncoder().encode("isolated-unwatermarked-master");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const asset: CharityHolderAsset = {
  class: "watermarked-holder",
  tokenId: "7",
  sha256: hash(watermarked),
  masterSha256: hash(master),
  contentType: "image/png",
  byteLength: watermarked.byteLength,
  objectKey: "charity/7/watermarked.png",
};
const config: HolderObjectConfig = {
  endpoint: new URL("https://store.example.com"),
  region: "auto",
  bucket: "charity-holder",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example-key",
};
const fetchResponse = (response: Response): typeof fetch =>
  (async () => response) as typeof fetch;
function responseChunks(chunks: Uint8Array[], headers?: HeadersInit) {
  let index = 0;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() {
      cancelled++;
    },
  });
  const response = new Response(body, { status: 200, headers });
  return { response, body, cancelled: () => cancelled };
}
afterEach(() => vi.useRealTimers());

describe("bounded private holder object reads", () => {
  it("verifies split streamed bytes before delivery without using arrayBuffer", async () => {
    const { response, body } = responseChunks([
      watermarked.slice(0, 5),
      watermarked.slice(5, 19),
      watermarked.slice(19),
    ]);
    const fullRead = vi
      .spyOn(response, "arrayBuffer")
      .mockRejectedValue(new Error("UNBOUNDED_READ_FORBIDDEN"));
    const result = await fetchHolderObject(
      asset,
      config,
      fetchResponse(response),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(watermarked);
    expect(fullRead).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("grows retained storage only as verified-size chunks arrive", async () => {
    const contents = new Uint8Array(150000).fill(17);
    const selected = {
      ...asset,
      byteLength: contents.byteLength,
      sha256: hash(contents),
    };
    const { response, body } = responseChunks([
      contents.slice(0, 50000),
      new Uint8Array(0),
      contents.slice(50000, 70000),
      contents.slice(70000),
    ]);
    const result = await fetchHolderObject(
      selected,
      config,
      fetchResponse(response),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(contents);
    expect(body.locked).toBe(false);
  });
  it("accepts a matching optional Content-Length", async () => {
    const { response } = responseChunks([watermarked], {
      "content-length": String(watermarked.byteLength),
    });
    const result = await fetchHolderObject(
      asset,
      config,
      fetchResponse(response),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects oversized or inconsistent headers and cancels without a body read", async () => {
    for (const [declared, refusal] of [
      [String(maxHolderObjectBytes + 1), "too-large"],
      ["1", "size-mismatch"],
      ["not-a-length", "size-mismatch"],
    ] as const) {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
      const response = new Response(body, {
        headers: { "content-length": declared },
      });
      const getReader = vi.spyOn(body, "getReader");
      expect(
        await fetchHolderObject(asset, config, fetchResponse(response)),
      ).toEqual({ ok: false, refusal });
      expect(getReader).not.toHaveBeenCalled();
      expect(cancelled).toBe(1);
    }
  });

  it("stops at the descriptor size even when the header claims an exact match", async () => {
    const { response, body, cancelled } = responseChunks(
      [watermarked, new Uint8Array([1]), new Uint8Array([2])],
      { "content-length": String(watermarked.byteLength) },
    );
    expect(
      await fetchHolderObject(asset, config, fetchResponse(response)),
    ).toEqual({
      ok: false,
      refusal: "size-mismatch",
    });
    expect(cancelled()).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("stops an over-limit native chunk before retaining it as the holder object", async () => {
    const chunk = new Uint8Array(maxHolderObjectBytes + 1);
    const { response, body, cancelled } = responseChunks([
      chunk,
      new Uint8Array([1]),
    ]);
    expect(
      await fetchHolderObject(
        { ...asset, byteLength: maxHolderObjectBytes },
        config,
        fetchResponse(response),
      ),
    ).toEqual({ ok: false, refusal: "too-large" });
    expect(cancelled()).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("rejects truncated, empty and interrupted bodies without exposing partial data", async () => {
    for (const chunks of [[], [watermarked.slice(0, -1)]]) {
      const { response, body } = responseChunks(chunks);
      expect(
        await fetchHolderObject(asset, config, fetchResponse(response)),
      ).toEqual({
        ok: false,
        refusal: "size-mismatch",
      });
      expect(body.locked).toBe(false);
    }
    expect(
      await fetchHolderObject(asset, config, fetchResponse(new Response(null))),
    ).toEqual({
      ok: false,
      refusal: "size-mismatch",
    });
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step++ === 0) controller.enqueue(watermarked.slice(0, 4));
        else controller.error(new Error("PRIVATE_UPSTREAM_DETAIL"));
      },
    });
    const result = await fetchHolderObject(
      asset,
      config,
      fetchResponse(new Response(body)),
    );
    expect(result).toEqual({ ok: false, refusal: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UPSTREAM_DETAIL");
    expect(body.locked).toBe(false);
  });

  it("retains complete-object digest and master separation checks", async () => {
    const swapped = responseChunks([master]);
    expect(
      await fetchHolderObject(
        { ...asset, byteLength: master.byteLength },
        config,
        fetchResponse(swapped.response),
      ),
    ).toEqual({ ok: false, refusal: "master-digest-collision" });
    const changed = watermarked.slice();
    changed[0] ^= 1;
    const altered = responseChunks([changed]);
    expect(
      await fetchHolderObject(asset, config, fetchResponse(altered.response)),
    ).toEqual({
      ok: false,
      refusal: "digest-mismatch",
    });
  });

  it("uses the original descriptor even if the caller mutates it during the request", async () => {
    const selected = { ...asset, byteLength: master.byteLength };
    const response = responseChunks([master]).response;
    const request = (async () => {
      selected.byteLength = master.byteLength;
      selected.sha256 = hash(master);
      selected.masterSha256 = hash(new Uint8Array([1]));
      return response;
    }) as typeof fetch;
    const result = await fetchHolderObject(selected, config, request);
    // The original master digest remains the forbidden one.
    expect(result).toEqual({ ok: false, refusal: "master-digest-collision" });
  });

  it("keeps a valid read bound to its original size and digest despite late caller changes", async () => {
    const selected = { ...asset };
    const request = (async () => {
      selected.byteLength = 1;
      selected.sha256 = hash(new Uint8Array([1]));
      return responseChunks([watermarked]).response;
    }) as typeof fetch;
    const result = await fetchHolderObject(selected, config, request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toEqual(watermarked);
  });

  it("enforces a total deadline while fetching headers, even if the injected fetch ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = ((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;
    const pending = fetchHolderObject(asset, config, request);
    await vi.advanceTimersByTimeAsync(maxHolderReadDurationMs);
    expect(await pending).toEqual({ ok: false, refusal: "unreachable" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a stalled body without waiting for an upstream cancellation promise", async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
        return new Promise<void>(() => undefined);
      },
    });
    const pending = fetchHolderObject(
      asset,
      config,
      fetchResponse(new Response(body)),
    );
    await vi.advanceTimersByTimeAsync(maxHolderReadDurationMs);
    expect(await pending).toEqual({ ok: false, refusal: "unreachable" });
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a response arriving after the deadline without delivering its bytes", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const request = (() =>
      new Promise<Response>((done) => {
        resolve = done;
      })) as typeof fetch;
    const pending = fetchHolderObject(asset, config, request);
    await vi.advanceTimersByTimeAsync(maxHolderReadDurationMs);
    expect(await pending).toEqual({ ok: false, refusal: "unreachable" });
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    resolve(new Response(body));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses invalid descriptor lengths without contacting a store", async () => {
    const request = vi.fn() as unknown as typeof fetch;
    for (const byteLength of [
      -1,
      0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        await fetchHolderObject({ ...asset, byteLength }, config, request),
      ).toEqual({
        ok: false,
        refusal: "size-mismatch",
      });
    }
    expect(request).not.toHaveBeenCalled();
  });
});
