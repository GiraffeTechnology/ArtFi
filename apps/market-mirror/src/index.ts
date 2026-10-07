import { Readable } from "node:stream";

import type { NormalizedMarketEvent } from "./adapter.js";
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

const stop = await startOpenSeaMirror(
  adapter,
  publish,
  publishSnapshot,
  (error) => {
    console.error("OpenSea mirror reconnect recovery failed", error);
    process.exitCode = 1;
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stop();
    process.exitCode = 0;
  });
}
