import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRANSLATION_REQUEST_BYTES,
  MAX_TRANSLATION_RESPONSE_BYTES,
  MAX_TRANSLATED_TEXT_BYTES,
  readTranslationJson,
} from "./translation-json";

const encoder = new TextEncoder();
const runtime = globalThis as typeof globalThis & {
  __artfiTranslationCache?: Map<string, string>;
};

beforeEach(() => {
  vi.resetModules();
  delete runtime.__artfiTranslationCache;
  vi.stubEnv("GIRAFFE_LANGUAGE_URL", "https://translation.invalid");
  vi.stubEnv("GIRAFFE_LANGUAGE_API_PREFIX", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function chunks(bytes: Uint8Array, width = 7) {
  let offset = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + width));
      offset = Math.min(bytes.length, offset + width);
    },
    cancel,
  });
  return { stream, cancel };
}

function request(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const body = chunks(bytes);
  return {
    ...body,
    message: new Request(
      "https://artfi.invalid/api/language/v1/translate-page",
      {
        method: "POST",
        headers,
        body: body.stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ),
  };
}

function translated(text: string) {
  return {
    translated_text: text,
    provider: "synthetic-approved-module",
    model: "fixture-model",
    warnings: [],
  };
}

describe("bounded translation JSON streams", () => {
  it("counts UTF-8 bytes and retains code points split across chunks", async () => {
    const value = { text: "English \u20ac \u6f22\u5b57" };
    const bytes = encoder.encode(JSON.stringify(value));
    const { stream } = chunks(bytes, 1);
    const message = new Response(stream);
    const unbounded = vi.spyOn(message, "json");
    await expect(readTranslationJson(message, bytes.length)).resolves.toEqual(
      value,
    );
    expect(unbounded).not.toHaveBeenCalled();
    await expect(
      readTranslationJson(new Response(bytes), bytes.length - 1),
    ).rejects.toThrow("TRANSLATION_JSON_TOO_LARGE");
  });

  it.each([undefined, "1", "invalid"])(
    "cancels an oversized stream with Content-Length %s",
    async (length) => {
      const cancel = vi.fn();
      let pulls = 0;
      const message = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(128));
          },
          cancel,
        }),
        { headers: length === undefined ? {} : { "content-length": length } },
      );
      await expect(readTranslationJson(message, 64)).rejects.toThrow(
        "TRANSLATION_JSON_TOO_LARGE",
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBeLessThan(4);
    },
  );

  it("refuses a declared oversized body without consuming it", async () => {
    const { stream, cancel } = chunks(encoder.encode('{"ok":true}'));
    await expect(
      readTranslationJson(
        new Response(stream, {
          headers: { "content-length": "99999999999999999999" },
        }),
        64,
      ),
    ).rejects.toThrow("TRANSLATION_JSON_TOO_LARGE");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses malformed UTF-8 instead of replacing its bytes", async () => {
    const { stream } = chunks(
      new Uint8Array([123, 34, 118, 34, 58, 34, 0xc3, 0x28, 34, 125]),
      1,
    );
    await expect(readTranslationJson(new Response(stream), 64)).rejects.toThrow(
      "INVALID_TRANSLATION_JSON",
    );
  });

  it("cancels a stalled body when the existing deadline aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const message = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      }),
    );
    const pending = expect(
      readTranslationJson(message, 64, controller.signal),
    ).rejects.toThrow("TRANSLATION_JSON_ABORTED");
    controller.abort();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("public translation request limits", () => {
  it.each([undefined, "1"])(
    "refuses oversized actual bytes before translation with header %s",
    async (length) => {
      // Every individual source is valid and below 600 characters; the actual
      // UTF-8 body exceeds 20,000 bytes while its JS character count does not.
      const body = JSON.stringify({
        target_language: "zht",
        texts: Array(12).fill("\u6f22".repeat(600)),
      });
      const bytes = encoder.encode(body);
      expect(body.length).toBeLessThan(MAX_TRANSLATION_REQUEST_BYTES);
      expect(bytes.length).toBeGreaterThan(MAX_TRANSLATION_REQUEST_BYTES);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const { POST } =
        await import("../app/api/language/v1/translate-page/route");
      const input = request(
        bytes,
        length === undefined ? {} : { "content-length": length },
      );
      const response = await POST(input.message);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: { code: "REQUEST_TOO_LARGE" },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(input.cancel).toHaveBeenCalledOnce();
    },
  );

  it.each(["{broken", "null", "[]", '{"target_language":"fr","texts":[]}'])(
    "returns a safe client error for %s",
    async (body) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const { POST } =
        await import("../app/api/language/v1/translate-page/route");
      const response = await POST(request(encoder.encode(body)).message);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INVALID_TRANSLATION_REQUEST" },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the normal approved-module request and response shape", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(translated("Texte traduit"))),
      );
    vi.stubGlobal("fetch", fetch);
    const { POST } =
      await import("../app/api/language/v1/translate-page/route");
    const input = { target_language: "fr", texts: ["Bounded English source"] };
    const response = await POST(
      request(encoder.encode(JSON.stringify(input))).message,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source_language: "auto",
      target_language: "fr",
      degraded: false,
      translations: ["Texte traduit"],
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://translation.invalid/v1/translate");
    expect(JSON.parse(init.body)).toMatchObject({
      source_text: input.texts[0],
      source_language: "en",
      target_language: "fr",
    });
    expect(init.cache).toBe("no-store");
  });
});

describe("bounded upstream results and English fallback", () => {
  it("does not return an oversized entry retained by a previous module version", async () => {
    const source = "Previously cached source";
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(translated("Revalidated cache value"))),
      );
    vi.stubGlobal("fetch", fetch);
    const { translatePageTexts } = await import("./language-server");
    runtime.__artfiTranslationCache!.set(
      `fr\u0000${source}`,
      "\u754c".repeat(3000),
    );
    expect(await translatePageTexts([source], "fr")).toEqual({
      degraded: false,
      translations: ["Revalidated cache value"],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(runtime.__artfiTranslationCache!.get(`fr\u0000${source}`)).toBe(
      "Revalidated cache value",
    );
  });

  it.each([undefined, "1"])(
    "does not cache a response over the byte cap with header %s",
    async (length) => {
      const source = `Oversized upstream source ${length ?? "absent"}`;
      const oversized = JSON.stringify({
        ...translated("Too large envelope"),
        padding: "x".repeat(MAX_TRANSLATION_RESPONSE_BYTES),
      });
      const first = chunks(encoder.encode(oversized), 1024);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(first.stream, {
            headers: length === undefined ? {} : { "content-length": length },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(translated("Reponse valide"))),
        );
      vi.stubGlobal("fetch", fetch);
      const { translatePageTexts } = await import("./language-server");
      expect(await translatePageTexts([source], "fr")).toEqual({
        degraded: true,
        translations: [source],
      });
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(await translatePageTexts([source], "fr")).toEqual({
        degraded: false,
        translations: ["Reponse valide"],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds translated UTF-8 bytes before caching, not just JS characters", async () => {
    const source = "Multibyte upstream output";
    const output = "\u754c".repeat(3000);
    expect(output.length).toBeLessThan(MAX_TRANSLATED_TEXT_BYTES);
    expect(encoder.encode(output).length).toBeGreaterThan(
      MAX_TRANSLATED_TEXT_BYTES,
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(translated(output))))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(translated("Valid output"))),
      );
    vi.stubGlobal("fetch", fetch);
    const { translatePageTexts } = await import("./language-server");
    expect(await translatePageTexts([source], "fr")).toEqual({
      degraded: true,
      translations: [source],
    });
    expect(await translatePageTexts([source], "fr")).toEqual({
      degraded: false,
      translations: ["Valid output"],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves order and successful translations when one stream fails", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const source = JSON.parse(String(init.body)).source_text;
      return source === "Failing Cedar source"
        ? new Response('{"private_internal_error":"DO_NOT_EXPOSE"')
        : new Response(JSON.stringify(translated("Texte valide Cedar")));
    });
    vi.stubGlobal("fetch", fetch);
    const { translatePageTexts } = await import("./language-server");
    const result = await translatePageTexts(
      ["Failing Cedar source", "Working Cedar source"],
      "fr",
    );
    expect(result).toEqual({
      degraded: true,
      translations: ["Failing Cedar source", "Texte valide Cedar"],
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE");
  });

  it("keeps the existing deadline active while a response body stalls", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TRANSLATION_TIMEOUT_MS", "1000");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {});
            },
            cancel,
          }),
        ),
      ),
    );
    const { translatePageTexts } = await import("./language-server");
    const pending = translatePageTexts(["Stalled body English source"], "fr");
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toEqual({
      degraded: true,
      translations: ["Stalled body English source"],
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
