import type { MarketplaceHealthSnapshot } from "./adapter.js";

export async function publishMarketplaceHealth(
  apiURL: string,
  indexerKey: string,
  snapshot: MarketplaceHealthSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${apiURL.replace(/\/$/, "")}/v1/indexer/market-health`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Indexer-Key": indexerKey,
      },
      body: JSON.stringify(snapshot),
    },
  );
  if (!response.ok) {
    throw new Error(
      `ArtFi provider health ingestion failed with HTTP ${response.status}`,
    );
  }
}
