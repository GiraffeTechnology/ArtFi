import { Readable } from "node:stream";

import type { NormalizedMarketEvent } from "./adapter.js";
import { publishMarketplaceHealth } from "./health-publisher.js";
import {
  eventFingerprint,
  OpenSeaAdapter,
  startOpenSeaMirror,
} from "./opensea.js";
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
  spoolParentDirectory: required("OPENSEA_BACKFILL_STATE_DIRECTORY"),
  staleAfterMs:
    boundedInteger("OPENSEA_STALE_AFTER_SECONDS", 60, 1, 86_400) * 1_000,
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

async function publishSnapshot(
  events: AsyncIterable<NormalizedMarketEvent>,
  signal: AbortSignal,
): Promise<void> {
  const body = Readable.from(
    (async function* () {
      for await (const event of events) {
        yield `${JSON.stringify(event)}\n`;
      }
    })(),
  );
  const response = await fetch(`${apiURL}/v1/indexer/market-snapshots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-Indexer-Key": indexerKey,
    },
    body: body as unknown as BodyInit,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) {
    throw new Error(
      `ArtFi mirror snapshot ingestion failed with HTTP ${response.status}`,
    );
  }
}

let healthPublishInFlight = false;
async function publishHealth(): Promise<void> {
  if (healthPublishInFlight) return;
  healthPublishInFlight = true;
  try {
    await publishMarketplaceHealth(apiURL, indexerKey, adapter.health());
  } catch (error) {
    console.error("ArtFi provider health report rejected", error);
  } finally {
    healthPublishInFlight = false;
  }
}
const healthInterval = setInterval(
  () => {
    void publishHealth();
  },
  boundedInteger("OPENSEA_HEALTH_REPORT_INTERVAL_SECONDS", 15, 5, 300) * 1_000,
);
await publishHealth();
let stop: () => void;
try {
  stop = await startOpenSeaMirror(
    adapter,
    publish,
    publishSnapshot,
    (error) => {
      console.error("OpenSea mirror reconnect recovery failed", error);
      process.exitCode = 1;
    },
  );
} catch (error) {
  clearInterval(healthInterval);
  await publishHealth();
  throw error;
}
await publishHealth();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(healthInterval);
    stop();
    void publishHealth().finally(() => {
      process.exitCode = 0;
    });
  });
}
