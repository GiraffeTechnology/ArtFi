import { PortfolioRecordsError } from "./portfolio-records-contract";

export const portfolioRequestTimeoutMs = 8_000;
export const maximumPortfolioResponseBytes = 2 * 1024 * 1024;

export class PortfolioRequestError extends Error {
  constructor(public readonly reason: "timeout" | "invalid" | "too-large") {
    super(
      reason === "timeout"
        ? "Portfolio records timed out. Retry indexed records."
        : "Portfolio records are unavailable.",
    );
  }
}

function discard(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    /* Already locked. */
  }
}

async function portfolioBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/.test(declared) ||
      BigInt(declared) > BigInt(maximumPortfolioResponseBytes))
  ) {
    discard(response);
    throw new PortfolioRequestError("too-large");
  }
  if (!response.body) throw new PortfolioRequestError("invalid");
  const reader = response.body.getReader();
  let done = false;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new PortfolioRequestError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    const parts: string[] = [];
    for (;;) {
      const item = await Promise.race([reader.read(), stopped]);
      signal.throwIfAborted();
      if (item.done) {
        done = true;
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > maximumPortfolioResponseBytes)
        throw new PortfolioRequestError("too-large");
      parts.push(decoder.decode(item.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!done) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* Best effort. */
      }
    }
    reader.releaseLock();
  }
}

/** Bound fetch and the decoded response together, without retrying or changing login. */
export async function requestPortfolioRecords(
  request: typeof fetch,
  address: string,
  parent: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new PortfolioRequestError("timeout"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(abort, portfolioRequestTimeoutMs);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const response = await request(
          `/api/portfolio/${encodeURIComponent(address)}`,
          {
            cache: "no-store",
            credentials: "same-origin",
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) {
          discard(response);
          controller.signal.throwIfAborted();
        }
        if (!response.ok) {
          discard(response);
          throw new PortfolioRecordsError("http", response.status);
        }
        return portfolioBody(response, controller.signal);
      }),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
