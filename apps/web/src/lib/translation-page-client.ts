import type { UiLocale } from "./language";

// The server permits up to 60 seconds for its translation/proofreading pipeline.
// Keep one overall browser deadline, including headers and the complete body.
export const translationPageTimeoutMs = 65_000;
export const maximumTranslationPageBytes = 64 * 1024;

export class TranslationPageError extends Error {
  constructor(
    readonly reason:
      "timeout" | "aborted" | "unavailable" | "invalid" | "too-large",
  ) {
    super("TRANSLATION_UNAVAILABLE");
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null) {
  try {
    void body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup cannot extend a failed request or replace its result.
  }
}

/** Same-origin display translation only; no provider, credential or wallet logic. */
export async function requestPageTranslations(
  locale: UiLocale,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new TranslationPageError("aborted");
  const body = JSON.stringify({ target_language: locale, texts });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let failure: TranslationPageError | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let ended = false;
  let settled = false;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      const interrupt = (reason: "timeout" | "aborted") => {
        if (failure) return;
        failure = new TranslationPageError(reason);
        reject(failure);
        controller.abort();
      };
      timer = setTimeout(() => interrupt("timeout"), translationPageTimeoutMs);
      onAbort = () => interrupt("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const fetching = Promise.resolve().then(() => {
      if (failure) throw failure;
      return fetch("/api/language/v1/translate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    });
    // A transport that ignores abort may still deliver a response after timeout.
    // Dispose of it without allowing a late body or translation into the cache.
    void fetching.then(
      (late) => {
        if (settled) cancelBody(late.body);
      },
      () => undefined,
    );
    response = await Promise.race([fetching, interrupted]);
    if (failure) throw failure;
    if (!response.ok) throw new TranslationPageError("unavailable");
    if (!response.body) throw new TranslationPageError("invalid");
    const declared = response.headers.get("content-length");
    if (
      declared &&
      /^\d+$/.test(declared) &&
      BigInt(declared) > BigInt(maximumTranslationPageBytes)
    )
      throw new TranslationPageError("too-large");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let bytes = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), interrupted]);
      if (failure) throw failure;
      if (item.done) {
        ended = true;
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > maximumTranslationPageBytes)
        throw new TranslationPageError("too-large");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof TranslationPageError) throw error;
    throw new TranslationPageError(
      error instanceof SyntaxError || error instanceof TypeError
        ? "invalid"
        : "unavailable",
    );
  } finally {
    settled = true;
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!ended) {
      controller.abort();
      if (reader) {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // A failed cancellation does not delay the English fallback.
        }
      } else if (response) cancelBody(response.body);
    }
    reader?.releaseLock();
  }
}
