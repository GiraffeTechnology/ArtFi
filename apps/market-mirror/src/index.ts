import type { NormalizedMarketEvent } from "./adapter.js";
import { publishMarketplaceHealth } from "./health-publisher.js";
import { eventFingerprint, OpenSeaAdapter } from "./opensea.js";
import { assertSinPublicChainExecution } from "./runtime-boundary.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

assertSinPublicChainExecution();

const apiURL = required("ARTFI_API_URL").replace(/\/$/, "");
const indexerKey = required("ARTFI_INDEXER_SHARED_KEY");
const adapter = new OpenSeaAdapter({
  apiKey: required("OPENSEA_API_KEY"),
  collectionSlugs: required("OPENSEA_COLLECTION_SLUGS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  backfillPages: boundedInteger("OPENSEA_BACKFILL_PAGES", 2, 1, 20),
  staleAfterMs:
    boundedInteger("OPENSEA_STALE_AFTER_SECONDS", 60, 1, 86_400) * 1_000,
});
const healthReportIntervalMs =
  boundedInteger("OPENSEA_HEALTH_REPORT_INTERVAL_SECONDS", 15, 5, 300) * 1_000;

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

async function publishHealth(): Promise<void> {
  await publishMarketplaceHealth(apiURL, indexerKey, adapter.health());
}

try {
  await adapter.backfill(publish);
} catch (error) {
  await publishHealth().catch((reportError: unknown) => {
    console.error("ArtFi provider health report rejected", reportError);
  });
  throw error;
}
await publishHealth();
const stop = await adapter.start(publish);
await publishHealth();
let healthPublishInFlight = false;
const healthInterval = setInterval(() => {
  if (healthPublishInFlight) return;
  healthPublishInFlight = true;
  void publishHealth()
    .catch((error: unknown) => {
      console.error("ArtFi provider health report rejected", error);
    })
    .finally(() => {
      healthPublishInFlight = false;
    });
}, healthReportIntervalMs);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(healthInterval);
    stop();
    void publishHealth()
      .catch((error: unknown) => {
        console.error("ArtFi final provider health report rejected", error);
      })
      .finally(() => {
        process.exitCode = 0;
      });
  });
}
