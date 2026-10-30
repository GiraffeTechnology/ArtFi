import type { MarketplaceHealthSnapshot } from "./adapter.js";

export async function publishMarketplaceHealth(
  apiURL: string,
  indexerKey: string,
  snapshot: MarketplaceHealthSnapshot,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Provider health report timeout is invalid");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Provider health report timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(`${apiURL.replace(/\/$/, "")}/v1/indexer/market-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Indexer-Key": indexerKey,
        },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      }),
      deadline,
    ]);
    void response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw new Error(
        `ArtFi provider health ingestion failed with HTTP ${response.status}`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
