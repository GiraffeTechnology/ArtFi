import type { NormalizedMarketEvent } from "./adapter.js";
import { eventFingerprint, OpenSeaAdapter } from "./opensea.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiURL = required("ARTFI_API_URL").replace(/\/$/, "");
const indexerKey = required("ARTFI_INDEXER_SHARED_KEY");
const adapter = new OpenSeaAdapter({
  apiKey: required("OPENSEA_API_KEY"),
  collectionSlugs: required("OPENSEA_COLLECTION_SLUGS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  backfillPages: Math.max(
    1,
    Math.min(20, Number(process.env.OPENSEA_BACKFILL_PAGES ?? "2")),
  ),
});

async function publish(event: NormalizedMarketEvent): Promise<void> {
  const response = await fetch(`${apiURL}/v1/indexer/market-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": eventFingerprint(event),
      "X-Indexer-Key": indexerKey,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(
      `ArtFi mirror ingestion failed with HTTP ${response.status}`,
    );
  }
}

await adapter.backfill(publish);
const stop = await adapter.start(publish);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stop();
    process.exitCode = 0;
  });
}
