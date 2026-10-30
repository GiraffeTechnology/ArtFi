/** Shared browser/server body reader. It contains no session, signature or credential logic. */
export const maximumUserJSONBytes = 16_384;

export class UserJSONError extends Error {
  constructor(
    public readonly reason: "too-large" | "invalid" | "aborted" | "timeout",
  ) {
    super("Wallet authentication JSON is unavailable.");
  }
}

export async function readUserJSON(
  message: Request | Response,
  { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 25_000)
    throw new RangeError("Invalid authentication body deadline.");
  const stream = message.body;
  if (!stream) throw new UserJSONError("invalid");
  const reader = stream.getReader();
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const declared = message.headers.get("content-length");
    if (
      declared &&
      (!/^[0-9]+$/.test(declared) ||
        BigInt(declared) > BigInt(maximumUserJSONBytes))
    )
      throw new UserJSONError("too-large");
    if (signal?.aborted) throw new UserJSONError("aborted");
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UserJSONError("timeout")), timeoutMs);
      if (signal) {
        onAbort = () => reject(new UserJSONError("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        // Cover an abort between the initial check and listener registration.
        if (signal.aborted) onAbort();
      }
    });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let size = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), interrupted]);
      if (item.done) {
        ended = true;
        break;
      }
      size += item.value.byteLength;
      if (size > maximumUserJSONBytes) throw new UserJSONError("too-large");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } catch (error) {
    if (error instanceof UserJSONError) throw error;
    throw new UserJSONError("invalid");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Cancellation is best effort. A hostile stream cannot extend the result deadline
    // by returning a cancellation promise which never settles.
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
