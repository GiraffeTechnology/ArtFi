import "server-only";

export function nativeOrderAPIURL(path: string) {
  const configured = process.env.ARTFI_API_URL?.trim();
  if (!configured) throw new Error("The order service is unavailable.");
  const base = new URL(configured);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(base.hostname)
      ))
  ) {
    throw new Error("The order service is unavailable.");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  return new URL(path.replace(/^\//, ""), base);
}

type OrderReadOptions = { signal?: AbortSignal; timeoutMs?: number };
export class NativeOrderReadError extends Error {
  constructor(
    public readonly reason: "too-large" | "timeout" | "aborted" | "invalid",
  ) {
    super(
      reason === "too-large"
        ? "The order payload is too large."
        : "The order payload could not be read.",
    );
  }
}

export async function nativeOrderResponse(
  response: Response,
  options: OrderReadOptions = {},
) {
  if (!response.ok) {
    // The refusal status is known. Its unread body cannot hold that response
    // open or expose internal details, even if cancellation never settles.
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      /* Already locked/cancelled. */
    }
    return Response.json(
      { detail: "The order service could not complete this request." },
      {
        status:
          response.status >= 400 && response.status < 600
            ? response.status
            : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  const text = await boundedOrderText(response.body, 2 * 1024 * 1024, options);
  const data: unknown = JSON.parse(text);
  return Response.json(data, {
    status: response.status,
    headers: { "cache-control": "no-store" },
  });
}

/** Never buffer an unbounded public request or upstream response. */
export async function boundedOrderText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  { signal, timeoutMs = 15_000 }: OrderReadOptions = {},
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  )
    throw new RangeError("Invalid order read bounds.");
  if (signal?.aborted) {
    try {
      void body?.cancel().catch(() => undefined);
    } catch {
      /* Already locked/cancelled. */
    }
    throw new NativeOrderReadError("aborted");
  }
  if (!body) return "";
  const reader = body.getReader();
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new NativeOrderReadError("timeout")),
        timeoutMs,
      );
      if (signal) {
        onAbort = () => reject(new NativeOrderReadError("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (signal?.aborted) throw new NativeOrderReadError("aborted");
      if (done) {
        ended = true;
        break;
      }
      length += value.byteLength;
      if (length > limit) {
        throw new NativeOrderReadError("too-large");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    if (error instanceof NativeOrderReadError) throw error;
    throw new NativeOrderReadError("invalid");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
