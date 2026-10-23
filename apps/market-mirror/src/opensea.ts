import { createHash } from "node:crypto";
import { LocalStorage } from "node-localstorage";
import { EventType, OpenSeaStreamClient } from "@opensea/stream-js";
import { WebSocket } from "ws";

import {
  MARKET_EVENT_SCHEMA_VERSION,
  type MarketEventFamily,
  type MarketEventSink,
  type MarketplaceAdapter,
  type NormalizedMarketEvent,
} from "./adapter.js";

type UnknownRecord = Record<string, unknown>;

const ORDER_EVENTS = new Set([
  "listing",
  "offer",
  "item_listed",
  "item_cancelled",
  "item_received_offer",
  "item_received_bid",
  "collection_offer",
  "trait_offer",
  "order_invalidate",
  "order_revalidate",
]);

const STREAM_EVENTS = [
  EventType.ITEM_LISTED,
  EventType.ITEM_SOLD,
  EventType.ITEM_TRANSFERRED,
  EventType.ITEM_METADATA_UPDATED,
  EventType.ITEM_RECEIVED_OFFER,
  EventType.ITEM_RECEIVED_BID,
  EventType.ITEM_CANCELLED,
  EventType.COLLECTION_OFFER,
  EventType.TRAIT_OFFER,
  EventType.ORDER_INVALIDATE,
  EventType.ORDER_REVALIDATE,
] as const;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function family(eventType: string): MarketEventFamily {
  if (ORDER_EVENTS.has(eventType)) return "order";
  if (eventType === "item_sold" || eventType === "sale") return "sale";
  if (
    eventType === "item_transferred" ||
    eventType === "transfer" ||
    eventType === "mint"
  )
    return "transfer";
  return "metadata";
}

function parseNFTID(value: unknown): {
  chain?: string;
  contractAddress?: string;
  tokenId?: string;
} {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") throw new Error("OPENSEA_NFT_ID_INVALID");
  const parts = value.split("/");
  if (parts.length !== 3) throw new Error("OPENSEA_NFT_ID_INVALID");
  const [chain, contractAddress, tokenId] = parts;
  return { chain, contractAddress, tokenId };
}

// Stream and REST can repeat an identity in multiple fields. A contradictory
// copy must not silently select another chain/token by precedence.
function identityField(
  values: unknown[],
  pattern: RegExp,
  lowercase = false,
): string | undefined {
  let resolved: string | undefined;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error("OPENSEA_TOKEN_IDENTITY_INVALID");
    }
    const normalized = lowercase ? value.toLowerCase() : value;
    if (resolved !== undefined && resolved !== normalized) {
      throw new Error("OPENSEA_TOKEN_IDENTITY_CONFLICT");
    }
    resolved = normalized;
  }
  return resolved;
}

// @opensea/stream-js 0.4.0 OrderValidationEvent uses { name } for
// payload.chain; item events and REST also use the string representation.
// Both variants feed the same consistency check, not a precedence fallback.
function chainName(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  const candidate = record(value);
  if (typeof candidate.name !== "string") {
    throw new Error("OPENSEA_TOKEN_IDENTITY_INVALID");
  }
  return candidate.name;
}

function timestamp(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("OpenSea event timestamp is missing");
  }
  // REST uses epoch seconds; Stream uses ISO timestamps. Never interpret a
  // REST second count as JavaScript milliseconds (which would date it to 1970).
  const parsed = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("OpenSea event timestamp is invalid");
  }
  return parsed.toISOString();
}

export function normalizeOpenSeaEvent(input: unknown): NormalizedMarketEvent {
  const event = record(input);
  const payload = record(event.payload ?? event);
  const item = record(payload.item ?? payload.nft ?? payload.asset);
  const paymentToken = record(payload.payment_token ?? payload.payment);
  const collection = record(payload.collection);
  const maker = record(payload.maker ?? payload.from_account);
  const transaction = record(payload.transaction);
  let eventType = text(
    event.event_type ?? event.eventType ?? payload.event_type,
  );
  if (!eventType) throw new Error("OpenSea event type is missing");
  if (eventType === "order") {
    const orderType = text(payload.order_type);
    if (orderType === "listing") eventType = "listing";
    else if (orderType === "item_offer") eventType = "offer";
    else if (orderType === "collection_offer" || orderType === "trait_offer")
      eventType = orderType;
    else throw new Error("OPENSEA_ORDER_EVENT_TYPE_UNSUPPORTED");
  }

  const nft = parseNFTID(item.nft_id);
  const payloadNFT = parseNFTID(payload.nft_id);
  const chain = identityField(
    [
      chainName(item.chain),
      chainName(payload.chain),
      chainName(event.chain),
      nft.chain,
      payloadNFT.chain,
    ],
    /^[a-z][a-z0-9-]{1,31}$/i,
    true,
  );
  if (!chain) throw new Error("OpenSea event chain is missing");

  const eventTimestamp = timestamp(
    payload.event_timestamp ??
      event.sent_at ??
      payload.created_date ??
      payload.event_timestamp,
  );
  const orderHash = text(payload.order_hash ?? payload.orderHash);
  const transactionHash = text(
    transaction.hash ??
      text(payload.transaction) ??
      payload.transaction_hash ??
      payload.transactionHash,
  );
  const contractAddress = identityField(
    [
      nft.contractAddress,
      payloadNFT.contractAddress,
      item.contract,
      payload.contract_address,
    ],
    /^0x[0-9a-f]{40}$/i,
    true,
  );
  const tokenId = identityField(
    [nft.tokenId, payloadNFT.tokenId, item.identifier, payload.token_id],
    /^(0|[1-9][0-9]{0,77})$/,
  );
  if (tokenId !== undefined && BigInt(tokenId) >= 2n ** 256n) {
    throw new Error("OPENSEA_TOKEN_IDENTITY_INVALID");
  }
  const assetKey =
    contractAddress && tokenId
      ? [chain, contractAddress, tokenId].join("/")
      : undefined;
  const entityKey =
    orderHash ?? text(item.nft_id ?? payload.nft_id) ?? assetKey;
  if (!entityKey) throw new Error("OpenSea event entity key is missing");

  const rawVersion = event.version ?? payload.version;
  const version =
    typeof rawVersion === "number" && Number.isSafeInteger(rawVersion)
      ? rawVersion
      : new Date(eventTimestamp).getTime();

  return {
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    source: "opensea",
    eventType,
    eventFamily: family(eventType),
    entityKey,
    version,
    chain: chain.toLowerCase(),
    collectionSlug: text(
      collection.slug ?? payload.collection_slug ?? item.collection,
    ),
    orderHash,
    transactionHash,
    contractAddress: contractAddress?.toLowerCase(),
    tokenId,
    makerAddress: text(
      maker.address ??
        text(payload.maker) ??
        payload.maker_address ??
        payload.seller ??
        payload.from_address,
    )?.toLowerCase(),
    price: text(
      payload.base_price ??
        payload.sale_price ??
        payload.price ??
        paymentToken.quantity,
    ),
    paymentTokenAddress: text(
      paymentToken.address ?? paymentToken.token_address,
    )?.toLowerCase(),
    paymentSymbol: text(paymentToken.symbol),
    marketplaceUrl: text(item.permalink ?? payload.permalink),
    eventTimestamp,
    payload,
  };
}

export function eventFingerprint(event: NormalizedMarketEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.schemaVersion,
        event.source,
        event.chain,
        event.eventFamily,
        event.entityKey,
        event.version,
        event.eventType,
        event.eventTimestamp,
      ]),
    )
    .digest("hex");
}

export interface OpenSeaAdapterConfig {
  apiKey: string;
  collectionSlugs: string[];
  backfillPages: number;
  fetchImpl?: typeof fetch;
  onBackfillComplete?: (completedThrough: number) => Promise<void>;
}

export class OpenSeaAdapter implements MarketplaceAdapter {
  readonly source = "opensea";
  readonly capabilities = {
    realtime: true,
    restBackfill: true,
    createsOrders: false,
    fulfillsOrders: false,
    custody: false,
  } as const;

  readonly #config: OpenSeaAdapterConfig;
  readonly #fetch: typeof fetch;
  #completedThrough?: number;
  #lastFullScanAt = 0;
  #backfillRetryNotBeforeMs = 0;
  #transportSnapshot: () =>
    "connecting" | "connected" | "disconnected" | "stopped" = () => "stopped";

  // Transport evidence only: an open socket does not attest channel joins,
  // historical coverage, or the freshness of any particular order.
  streamObservation() {
    return {
      schemaVersion: "1" as const,
      source: this.source,
      collections: [...this.#config.collectionSlugs],
      transportState: this.#transportSnapshot(),
      observedAtMs: Date.now(),
    };
  }

  constructor(config: OpenSeaAdapterConfig) {
    if (!config.apiKey || config.collectionSlugs.length === 0) {
      throw new Error(
        "OpenSea API key and at least one collection slug are required",
      );
    }
    if (
      config.collectionSlugs.length > 100 ||
      new Set(config.collectionSlugs).size !== config.collectionSlugs.length ||
      config.collectionSlugs.some(
        (slug) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(slug),
      )
    ) {
      throw new Error("OPENSEA_COLLECTION_SCOPE_INVALID");
    }
    if (
      !Number.isSafeInteger(config.backfillPages) ||
      config.backfillPages < 1 ||
      config.backfillPages > 20
    ) {
      throw new Error("OpenSea backfill batch size must be between 1 and 20");
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void> {
    // Freeze the window while paging. New stream events continue to ingest;
    // the following sweep overlaps this window to cover second-level bounds.
    // A restart deliberately performs a full idempotent scan from the start.
    const before = Math.floor(Date.now() / 1000);
    // Periodic full sweeps also pick up provider records indexed later than the
    // overlap window; the in-memory watermark is only a polling optimization.
    const completedThrough = this.#completedThrough;
    const fullScan =
      completedThrough === undefined || before - this.#lastFullScanAt >= 3600;
    const after =
      completedThrough === undefined || fullScan
        ? undefined
        : Math.max(0, completedThrough - 60);
    for (const slug of this.#config.collectionSlugs) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let pages = 0;
      do {
        signal?.throwIfAborted();
        const url = new URL(
          `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}`,
        );
        url.searchParams.set("limit", "200");
        url.searchParams.set("before", String(before));
        if (after !== undefined) url.searchParams.set("after", String(after));
        if (cursor) url.searchParams.set("next", cursor);
        const body = await this.#fetchBackfillPage(url, signal);
        if (!Array.isArray(body.asset_events)) {
          throw new Error("OPENSEA_BACKFILL_INVALID_EVENTS");
        }
        for (const event of body.asset_events) {
          signal?.throwIfAborted();
          const normalized = normalizeOpenSeaEvent(event);
          await sink({
            ...normalized,
            collectionSlug: normalized.collectionSlug ?? slug,
          });
        }
        if (
          body.next !== undefined &&
          body.next !== null &&
          typeof body.next !== "string"
        ) {
          throw new Error("OPENSEA_BACKFILL_INVALID_CURSOR");
        }
        cursor = text(body.next);
        if (cursor) {
          if (cursor.length > 4096 || seenCursors.has(cursor)) {
            throw new Error("OPENSEA_BACKFILL_CURSOR_LOOP");
          }
          seenCursors.add(cursor);
        }
        pages += 1;
        // This is a burst size, never a history truncation limit.
        if (cursor && pages % this.#config.backfillPages === 0) {
          await waitForBackfill(1000, signal);
        }
      } while (cursor);
    }
    // Persist coverage only after every page and event has been ingested.
    // A failed observation write must not advance the polling watermark.
    await this.#config.onBackfillComplete?.(before);
    this.#completedThrough = before;
    if (fullScan) this.#lastFullScanAt = before;
  }

  async #fetchBackfillPage(
    url: URL,
    signal?: AbortSignal,
  ): Promise<UnknownRecord> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      signal?.throwIfAborted();
      if (Date.now() < this.#backfillRetryNotBeforeMs) {
        throw new Error("OPENSEA_BACKFILL_RETRY_DEFERRED");
      }
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: { "x-api-key": this.#config.apiKey },
          redirect: "error",
          signal: requestSignal,
        });
      } catch {
        signal?.throwIfAborted();
        if (attempt === 4)
          throw new Error("OPENSEA_BACKFILL_NETWORK_UNAVAILABLE");
        await waitForBackfill(Math.min(30_000, 1000 * 2 ** attempt), signal);
        continue;
      }
      if (response.ok) return record(await response.json());
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        await response.body?.cancel();
        throw new Error(`OPENSEA_BACKFILL_HTTP_${response.status}`);
      }
      const retryAfter = response.headers.get("retry-after")?.trim();
      await response.body?.cancel();
      let waitMs = Math.min(30_000, 1000 * 2 ** attempt);
      if (retryAfter) {
        const requestedMs = /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
        if (requestedMs > 0) {
          this.#backfillRetryNotBeforeMs = Math.max(
            this.#backfillRetryNotBeforeMs,
            Date.now() + requestedMs,
          );
        }
        // Never clamp a provider's longer pause into an early retry. Retain
        // the old window; the outer loop may attempt it after this cooldown.
        if (requestedMs > 60_000) {
          throw new Error("OPENSEA_BACKFILL_RETRY_DEFERRED");
        }
        if (Number.isFinite(requestedMs))
          waitMs = Math.max(waitMs, requestedMs);
      }
      if (attempt === 4) {
        throw new Error(`OPENSEA_BACKFILL_HTTP_${response.status}`);
      }
      await waitForBackfill(waitMs, signal);
    }
    throw new Error("OPENSEA_BACKFILL_RETRY_EXHAUSTED");
  }

  async start(sink: MarketEventSink): Promise<() => void> {
    const storagePath =
      process.env.OPENSEA_STREAM_STORAGE_PATH?.trim() || ".opensea-stream";
    let sessionStorage: LocalStorage;
    try {
      sessionStorage = new LocalStorage(storagePath);
    } catch {
      // Never print the configured filesystem path or raw filesystem errors.
      throw new Error("OPENSEA_STREAM_STORAGE_UNAVAILABLE");
    }
    let currentSocket: WebSocket | undefined;
    let stopped = false;
    // Phoenix's public transport option avoids reading private SDK socket or
    // channel fields. Only the newest transport can determine this snapshot.
    class ObservedTransport extends WebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        currentSocket = this;
      }
    }
    this.#transportSnapshot = () => {
      if (stopped) return "stopped";
      if (!currentSocket || currentSocket.readyState === WebSocket.CONNECTING)
        return "connecting";
      return currentSocket.readyState === WebSocket.OPEN
        ? "connected"
        : "disconnected";
    };
    const client = new OpenSeaStreamClient({
      token: this.#config.apiKey,
      connectOptions: { transport: ObservedTransport, sessionStorage },
      onError: () => console.error("OPENSEA_STREAM_CONNECTION_ERROR"),
    });
    // Phoenix consumes a Storage-compatible instance for fallback history;
    // passing the constructor or mutating NODE_LOCALSTORAGE does not initialize it.
    const unsubscribe = this.#config.collectionSlugs.map((slug) =>
      client.onEvents(slug, [...STREAM_EVENTS], (event) => {
        void Promise.resolve()
          .then(() => {
            const normalized = normalizeOpenSeaEvent(event);
            return sink({
              ...normalized,
              collectionSlug: normalized.collectionSlug ?? slug,
            });
          })
          .catch(() => {
            console.error("OPENSEA_STREAM_EVENT_REJECTED");
          });
      }),
    );
    client.connect();
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        for (const stop of unsubscribe) stop();
      } finally {
        client.disconnect();
      }
    };
  }
}

function waitForBackfill(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("OPENSEA_BACKFILL_ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
