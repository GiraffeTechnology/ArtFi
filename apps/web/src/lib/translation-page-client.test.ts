import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maximumTranslationPageBytes,
  requestPageTranslations,
  translationPageTimeoutMs,
} from "./translation-page-client";

const encoder = new TextEncoder();
const source = ["Receipt pending TEST_ONLY"];
const value = {
  degraded: false,
  translations: ["Réception en attente TEST_ONLY"],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function transport(response: Response | Promise<Response>) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function stalledBody(cancel: () => void | Promise<void>) {
  return new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel,
  });
}

describe("browser page translation transport bounds", () => {
  it("streams split UTF-8 without using unbounded JSON and preserves the fixed request", async () => {
    const bytes = encoder.encode(JSON.stringify(value));
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          controller.enqueue(bytes.slice(offset, ++offset));
        },
      }),
    );
    const json = vi.spyOn(response, "json");
    const fetcher = transport(response);
    const signal = new AbortController().signal;
    const removeListener = vi.spyOn(signal, "removeEventListener");
    await expect(
      requestPageTranslations("fr", source, signal),
    ).resolves.toEqual(value);
    expect(json).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/language/v1/translate-page",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ target_language: "fr", texts: source }),
      }),
    );
    expect(response.body!.locked).toBe(false);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts a response at the actual byte boundary", async () => {
    const json = JSON.stringify(value);
    transport(
      new Response(
        " ".repeat(maximumTranslationPageBytes - encoder.encode(json).length) +
          json,
      ),
    );
    await expect(
      requestPageTranslations("fr", source, new AbortController().signal),
    ).resolves.toEqual(value);
  });

  it.each([undefined, "1", "invalid"])(
    "refuses actual oversized bytes with declared length %s",
    async (length) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(maximumTranslationPageBytes + 1));
          },
          cancel,
        }),
        { headers: length === undefined ? {} : { "content-length": length } },
      );
      const fetcher = transport(response);
      await expect(
        requestPageTranslations("fr", source, new AbortController().signal),
      ).rejects.toMatchObject({ reason: "too-large" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("refuses declared overflow without waiting for body bytes", async () => {
    const cancel = vi.fn();
    transport(
      new Response(stalledBody(cancel), {
        headers: { "content-length": String(maximumTranslationPageBytes + 1) },
      }),
    );
    await expect(
      requestPageTranslations("fr", source, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "too-large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["utf8", "json", "empty", "locked"] as const)(
    "refuses %s response data without exposing upstream details",
    async (mode) => {
      const response = new Response(
        mode === "empty"
          ? null
          : mode === "utf8"
            ? new Uint8Array([0xc3, 0x28])
            : mode === "json"
              ? "{invalid"
              : JSON.stringify(value),
      );
      const reader = mode === "locked" ? response.body!.getReader() : undefined;
      transport(response);
      try {
        await expect(
          requestPageTranslations("fr", source, new AbortController().signal),
        ).rejects.toMatchObject({
          reason: "invalid",
          message: "TRANSLATION_UNAVAILABLE",
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        reader?.releaseLock();
      }
    },
  );

  it.each(["pending", "rejected"])(
    "an HTTP rejection does not await %s body cleanup",
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === "pending"
          ? new Promise<void>(() => {})
          : Promise.reject(new Error("Synthetic cleanup failure")),
      );
      const fetcher = transport(
        new Response(stalledBody(cancel), { status: 503 }),
      );
      await expect(
        requestPageTranslations("fr", source, new AbortController().signal),
      ).rejects.toMatchObject({ reason: "unavailable" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("times out ignored-abort headers and cancels a late response without retrying", async () => {
    let deliver!: (response: Response) => void;
    const fetcher = transport(
      new Promise<Response>((resolve) => (deliver = resolve)),
    );
    const pending = expect(
      requestPageTranslations("fr", source, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(translationPageTimeoutMs);
    await pending;
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    const cancel = vi.fn();
    deliver(new Response(stalledBody(cancel)));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pending", "rejected"])(
    "a body deadline is independent of %s cancellation",
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === "pending"
          ? new Promise<void>(() => {})
          : Promise.reject(new Error("Synthetic cleanup failure")),
      );
      const response = new Response(stalledBody(cancel));
      const fetcher = transport(response);
      const pending = expect(
        requestPageTranslations("fr", source, new AbortController().signal),
      ).rejects.toMatchObject({ reason: "timeout" });
      await vi.advanceTimersByTimeAsync(translationPageTimeoutMs);
      await pending;
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body!.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not dispatch an already-aborted locale request", async () => {
    const fetcher = transport(Response.json(value));
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestPageTranslations("fr", source, controller.signal),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "locale disposal interrupts pending %s without waiting for the deadline",
    async (phase) => {
      const cancel = vi.fn();
      const fetcher = transport(
        phase === "headers"
          ? new Promise<Response>(() => {})
          : new Response(stalledBody(cancel)),
      );
      const controller = new AbortController();
      const pending = expect(
        requestPageTranslations("fr", source, controller.signal),
      ).rejects.toMatchObject({ reason: "aborted" });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await pending;
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(phase === "body" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses a single deadline across both headers and body", async () => {
    let deliver!: (response: Response) => void;
    transport(new Promise<Response>((resolve) => (deliver = resolve)));
    const pending = expect(
      requestPageTranslations("fr", source, new AbortController().signal),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    const cancel = vi.fn();
    deliver(new Response(stalledBody(cancel)));
    await vi.advanceTimersByTimeAsync(translationPageTimeoutMs - 30_000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshots the source batch before asynchronous dispatch", async () => {
    const fetcher = transport(Response.json(value));
    const texts = [...source];
    const pending = requestPageTranslations(
      "fr",
      texts,
      new AbortController().signal,
    );
    texts[0] = "A different authoritative status";
    await pending;
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).texts).toEqual(
      source,
    );
  });
});
