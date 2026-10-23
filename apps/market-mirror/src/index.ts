import { setTimeout as delay } from "node:timers/promises";

import type { NormalizedMarketEvent } from "./adapter.js";
import { publishMarketEvent } from "./event-publisher.js";
import {
  readCurrentListing,
  type MarketTokenIdentity,
} from "./current-listing.js";
import { eventFingerprint, OpenSeaAdapter } from "./opensea.js";
import { assertSinPublicChainExecution } from "./runtime-boundary.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

assertSinPublicChainExecution();

const apiURL = required("ARTFI_API_URL").replace(/\/$/, "");
const indexerKey = required("ARTFI_INDEXER_SHARED_KEY");
const openseaKey = required("OPENSEA_API_KEY");
const shutdown = new AbortController();
const collectionSlugs = [
  ...new Set(
    required("OPENSEA_COLLECTION_SLUGS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];
const adapter = new OpenSeaAdapter({
  apiKey: openseaKey,
  collectionSlugs,
  onBackfillComplete: (through) => reportObservation("complete", through),
  backfillPages: Math.max(
    1,
    Math.min(20, Number(process.env.OPENSEA_BACKFILL_PAGES ?? "2")),
  ),
});

async function reportObservation(
  status: "complete" | "unavailable",
  completedThrough?: number,
): Promise<void> {
  const response = await fetch(`${apiURL}/v1/indexer/market-observations`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Indexer-Key": indexerKey,
    },
    body: JSON.stringify({
      schemaVersion: "1",
      source: "opensea",
      collections: collectionSlugs,
      status,
      observedAtMs: Date.now(),
      completedThrough,
    }),
    signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("MARKET_OBSERVATION_WRITE_REFUSED");
}

async function publish(event: NormalizedMarketEvent): Promise<void> {
  await publishMarketEvent(
    `${apiURL}/v1/indexer/market-events`,
    indexerKey,
    JSON.stringify(event),
    eventFingerprint(event),
    shutdown.signal,
  );
}

async function pollStream(): Promise<void> {
  try {
    while (!shutdown.signal.aborted) {
      try {
        const response = await fetch(`${apiURL}/v1/indexer/market-streams`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Indexer-Key": indexerKey,
          },
          body: JSON.stringify(adapter.streamObservation()),
          redirect: "error",
          signal: AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("MARKET_STREAM_OBSERVATION_REFUSED");
      } catch {
        if (!shutdown.signal.aborted)
          console.error("MARKET_STREAM_OBSERVATION_UNAVAILABLE");
      }
      await delay(15_000, undefined, { signal: shutdown.signal });
    }
  } catch {
    if (!shutdown.signal.aborted)
      console.error("MARKET_STREAM_OBSERVATION_STOPPED");
  }
}

async function refreshListings(): Promise<void> {
  const assets: MarketTokenIdentity[] = [];
  const seen = new Set<string>();
  let page = 1;
  let total = 0;
  do {
    const response = await fetch(
      `${apiURL}/v1/market/assets?source=opensea&page=${page}&pageSize=100`,
      {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("MARKET_CATALOG_UNAVAILABLE");
    }
    const body = await response.json();
    if (
      !body ||
      body.runtime !== true ||
      body.source !== "opensea" ||
      body.page !== page ||
      body.pageSize !== 100 ||
      !Number.isSafeInteger(body.total) ||
      body.total < 0 ||
      !Array.isArray(body.data) ||
      body.data.length > 100
    )
      throw new Error("MARKET_CATALOG_INVALID");
    for (const asset of body.data) {
      if (
        !asset ||
        asset.source !== "opensea" ||
        !/^[a-z][a-z0-9-]{1,31}$/.test(asset.chain) ||
        !/^0x[0-9a-f]{40}$/.test(asset.contractAddress) ||
        !/^(0|[1-9][0-9]{0,77})$/.test(asset.tokenId) ||
        BigInt(asset.tokenId) >= 2n ** 256n
      )
        throw new Error("MARKET_CATALOG_IDENTITY_INVALID");
      const key = `${asset.chain}:${asset.contractAddress}:${asset.tokenId}`;
      if (seen.has(key)) throw new Error("MARKET_CATALOG_DUPLICATE");
      seen.add(key);
      // Do not spread an API object into the authenticated collector envelope.
      assets.push({
        chain: asset.chain,
        contractAddress: asset.contractAddress,
        tokenId: asset.tokenId,
        collectionSlug:
          typeof asset.collectionSlug === "string"
            ? asset.collectionSlug
            : undefined,
      });
    }
    total = body.total;
    if (assets.length < total && body.data.length === 0)
      throw new Error("MARKET_CATALOG_TRUNCATED");
    page += 1;
  } while (assets.length < total && page <= 100);
  if (assets.length !== total) throw new Error("MARKET_CATALOG_TRUNCATED");
  const scoped = assets.filter(
    (asset) =>
      asset.collectionSlug && collectionSlugs.includes(asset.collectionSlug),
  );
  // Bounded parallel public GETs; no wallet or fulfillment endpoint is involved.
  for (let offset = 0; offset < scoped.length; offset += 4) {
    shutdown.signal.throwIfAborted();
    const results = await Promise.allSettled(
      scoped.slice(offset, offset + 4).map(async (asset) => {
        const observation = await readCurrentListing(
          asset,
          openseaKey,
          shutdown.signal,
        );
        const response = await fetch(`${apiURL}/v1/indexer/market-listings`, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "X-Indexer-Key": indexerKey,
          },
          body: JSON.stringify(observation),
          signal: AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(15_000),
          ]),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("MARKET_LISTING_WRITE_REFUSED");
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("MARKET_LISTING_BATCH_INCOMPLETE");
    await delay(250, undefined, { signal: shutdown.signal });
  }
}

async function pollListings(): Promise<void> {
  try {
    while (!shutdown.signal.aborted) {
      try {
        await refreshListings();
      } catch {
        if (!shutdown.signal.aborted)
          console.error("MARKET_LISTING_REFRESH_INCOMPLETE");
      }
      await delay(30_000, undefined, { signal: shutdown.signal });
    }
  } catch {
    if (!shutdown.signal.aborted) console.error("MARKET_LISTING_POLL_STOPPED");
  }
}

// Subscribe first so a long initial history scan cannot create a stream gap.
const stop = await adapter.start(publish);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown.abort();
    stop();
    process.exitCode = 0;
  });
}

// Listing probes are independent of potentially long historical cursor sweeps.
const listingPoll = pollListings();
const streamPoll = pollStream();
try {
  while (!shutdown.signal.aborted) {
    try {
      await adapter.backfill(publish, shutdown.signal);
      console.info("MARKET_BACKFILL_WINDOW_COMPLETE");
    } catch {
      if (shutdown.signal.aborted) break;
      // The adapter advances its window only after every collection completes.
      // Retrying the old window replays durable events without skipping a gap.
      console.error("MARKET_BACKFILL_RETRY_PENDING");
      try {
        await reportObservation("unavailable");
      } catch {
        // Existing observations expire even when the API cannot be reached.
        console.error("MARKET_OBSERVATION_UNAVAILABLE");
      }
    }
    await delay(30_000, undefined, { signal: shutdown.signal });
  }
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  shutdown.abort();
  stop();
  await listingPoll;
  await streamPoll;
}
