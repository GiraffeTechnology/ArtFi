import "server-only";

export const MAX_TRANSLATION_REQUEST_BYTES = 20_000;
export const MAX_TRANSLATION_RESPONSE_BYTES = 64 * 1024;
export const MAX_TRANSLATED_TEXT_BYTES = 8 * 1024;

export class TranslationJsonTooLargeError extends Error {
  constructor() {
    super("TRANSLATION_JSON_TOO_LARGE");
  }
}

// Count actual stream bytes before decoding or JSON parsing. Content-Length is
// only an optional early refusal; absent, false or compressed lengths never
// replace the stream limit. A fetch Response exposes decompressed body bytes.
export async function readTranslationJson(
  message: Request | Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_TRANSLATION_RESPONSE_BYTES
  )
    throw new RangeError("INVALID_TRANSLATION_JSON_LIMIT");
  const stream = message.body;
  if (!stream) throw new SyntaxError("EMPTY_TRANSLATION_JSON");
  const reader = stream.getReader();
  let ended = false;
  let onAbort: (() => void) | undefined;
  try {
    const declared = message.headers.get("content-length");
    if (
      declared &&
      /^\d+$/.test(declared) &&
      BigInt(declared) > BigInt(maximumBytes)
    ) {
      throw new TranslationJsonTooLargeError();
    }
    if (signal?.aborted) throw new Error("TRANSLATION_JSON_ABORTED");
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("TRANSLATION_JSON_ABORTED"));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    function decode(value?: Uint8Array, stream = false) {
      try {
        return decoder.decode(value, { stream });
      } catch {
        throw new SyntaxError("INVALID_TRANSLATION_JSON");
      }
    }
    const parts: string[] = [];
    let bytes = 0;
    while (true) {
      const reading = reader.read();
      const item = await (aborted ? Promise.race([reading, aborted]) : reading);
      if (item.done) {
        ended = true;
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > maximumBytes) throw new TranslationJsonTooLargeError();
      parts.push(decode(item.value, true));
    }
    parts.push(decode());
    return JSON.parse(parts.join(""));
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
