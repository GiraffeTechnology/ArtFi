import { setTimeout as delay } from "node:timers/promises";

// Retrying a durable write is safe only with identical bytes and identity.
// This is bounded transient recovery, not a durable queue or no-loss promise.
export async function publishMarketEvent(
  endpoint: string,
  indexerKey: string,
  body: string,
  fingerprint: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": fingerprint,
          "X-Indexer-Key": indexerKey,
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      signal.throwIfAborted();
      // Never propagate an error containing the credential-bearing endpoint.
    }

    const status = response?.status;
    const retryAfter = response?.headers.get("retry-after");
    // A body cleanup failure must not turn an acknowledged write into failure.
    await response?.body?.cancel().catch(() => undefined);
    if (status === 200 || status === 201) return;
    if (
      status !== undefined &&
      status !== 429 &&
      (status < 500 || status > 599)
    ) {
      throw new Error("MARKET_EVENT_WRITE_REFUSED");
    }
    if (attempt === 2) throw new Error("MARKET_EVENT_RETRY_EXHAUSTED");

    let waitMs = 1_000 * 2 ** attempt;
    if (retryAfter) {
      const requestedMs = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1_000
        : Date.parse(retryAfter) - Date.now();
      // Do not violate a long server-directed delay by retrying early.
      if (requestedMs > 30_000) throw new Error("MARKET_EVENT_RETRY_DEFERRED");
      if (Number.isFinite(requestedMs)) waitMs = Math.max(waitMs, requestedMs);
    }
    await delay(waitMs, undefined, { signal });
  }
}
