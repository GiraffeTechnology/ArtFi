/** Native NFT transport only. Successful JSON is still admitted by each action's reader. */
export const maximumNftResponseBytes = 1_048_576;
export const nftRequestTimeoutMs = 60_000;
const unavailable =
  "The NFT response is unavailable. Check or recover the original operation before trying again.";

export class NftAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NftAPIError";
  }
}

async function readResponse(
  response: Response,
  interrupted: Promise<never>,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Unreadable body");
  let ended = false;
  try {
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) ||
        BigInt(declared) > BigInt(maximumNftResponseBytes))
    )
      throw new Error("Body limit");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let bytes = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), interrupted]);
      if (item.done) {
        ended = true;
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > maximumNftResponseBytes) throw new Error("Body limit");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    const value: unknown = JSON.parse(parts.join(""));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid response object");
    return value as Record<string, unknown>;
  } finally {
    // A cancellation promise must not extend the request deadline.
    if (!ended) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Cleanup cannot replace the original transport outcome.
      }
    }
    reader.releaseLock();
  }
}

export async function requestNftAPI<T>(
  action: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new NftAPIError(504, unavailable));
    }, nftRequestTimeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(`/api/nft/${action}${query ? `?${query}` : ""}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }),
      interrupted,
    ]);
    let value: Record<string, unknown>;
    try {
      value = await readResponse(response, interrupted);
    } catch (error) {
      // Authentication status still retires private UI state if its body is broken.
      if (!response.ok) throw new NftAPIError(response.status, unavailable);
      if (timedOut) throw new NftAPIError(504, unavailable);
      if (error instanceof NftAPIError) throw error;
      throw new NftAPIError(502, unavailable);
    }
    if (!response.ok) {
      const detail = value.detail;
      throw new NftAPIError(
        response.status,
        typeof detail === "string" &&
          detail.length > 0 &&
          detail.length <= 512 &&
          !/[\x00-\x1f\x7f]/.test(detail)
          ? detail
          : unavailable,
      );
    }
    return value as T;
  } catch (error) {
    if (error instanceof NftAPIError) throw error;
    if (timedOut) throw new NftAPIError(504, unavailable);
    throw new NftAPIError(503, unavailable);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
