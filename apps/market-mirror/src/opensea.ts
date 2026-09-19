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
  if (eventType === "item_transferred" || eventType === "transfer")
    return "transfer";
  return "metadata";
}

function parseNFTID(value: string | undefined): {
  chain?: string;
  contractAddress?: string;
  tokenId?: string;
} {
  if (!value) return {};
  const [chain, contractAddress, tokenId] = value.split("/");
  return { chain, contractAddress, tokenId };
}

function timestamp(value: unknown): string {
  const parsed = new Date(
    typeof value === "number" || typeof value === "string" ? value : Date.now(),
  );
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("OpenSea event timestamp is invalid");
  }
  return parsed.toISOString();
}

export function normalizeOpenSeaEvent(input: unknown): NormalizedMarketEvent {
  const event = record(input);
  const payload = record(event.payload ?? event);
  const item = record(payload.item ?? payload.nft);
  const metadata = record(item.metadata);
  const paymentToken = record(payload.payment_token ?? payload.payment);
  const collection = record(payload.collection);
  const maker = record(payload.maker ?? payload.from_account);
  const transaction = record(payload.transaction);
  const eventType = text(
    event.event_type ?? event.eventType ?? payload.event_type,
  );
  if (!eventType) throw new Error("OpenSea event type is missing");

  const nft = parseNFTID(text(item.nft_id ?? payload.nft_id));
  const chain =
    text(record(item.chain).name) ??
    text(payload.chain) ??
    text(event.chain) ??
    nft.chain;
  if (!chain) throw new Error("OpenSea event chain is missing");

  const eventTimestamp = timestamp(
    payload.event_timestamp ??
      event.sent_at ??
      payload.created_date ??
      payload.event_timestamp,
  );
  const orderHash = text(payload.order_hash ?? payload.orderHash);
  const transactionHash = text(
    transaction.hash ?? payload.transaction_hash ?? payload.transactionHash,
  );
  const contractAddress = text(
    nft.contractAddress ?? item.contract ?? payload.contract_address,
  );
  const tokenId = text(nft.tokenId ?? item.identifier ?? payload.token_id);
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
    collectionSlug: text(collection.slug ?? payload.collection_slug),
    orderHash,
    transactionHash,
    contractAddress: contractAddress?.toLowerCase(),
    tokenId,
    makerAddress: text(maker.address ?? payload.maker_address)?.toLowerCase(),
    price: text(payload.base_price ?? payload.sale_price ?? payload.price),
    paymentTokenAddress: text(paymentToken.address)?.toLowerCase(),
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
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
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
  readonly #retryAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #requestTimeoutMs: number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(config: OpenSeaAdapterConfig) {
    if (!config.apiKey || config.collectionSlugs.length === 0) {
      throw new Error(
        "OpenSea API key and at least one collection slug are required",
      );
    }
    const retryAttempts = config.retryAttempts ?? 3;
    const retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(config.backfillPages) ||
      config.backfillPages < 1 ||
      config.backfillPages > 1_000 ||
      !Number.isSafeInteger(retryAttempts) ||
      retryAttempts < 1 ||
      retryAttempts > 5 ||
      !Number.isSafeInteger(retryBaseDelayMs) ||
      retryBaseDelayMs < 1 ||
      retryBaseDelayMs > 30_000 ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 120_000
    ) {
      throw new Error("OpenSea backfill configuration is invalid");
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#retryAttempts = retryAttempts;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#sleep = config.sleep ?? sleepWithAbort;
  }

  async backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void> {
    for (const slug of this.#config.collectionSlugs) {
      let cursor: string | undefined;
      const observedCursors = new Set<string>();
      for (let page = 0; page < this.#config.backfillPages; page += 1) {
        const url = new URL(
          `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}`,
        );
        url.searchParams.set("limit", "200");
        if (cursor) url.searchParams.set("next", cursor);
        const response = await this.#fetchBackfillPage(url, signal);
        if (!response.ok) {
          throw new Error(
            `OpenSea backfill failed with HTTP ${response.status}`,
          );
        }
        const body = record(await response.json());
        const events = Array.isArray(body.asset_events)
          ? body.asset_events
          : [];
        for (const event of events) await sink(normalizeOpenSeaEvent(event));
        const nextCursor = text(body.next);
        if (nextCursor && observedCursors.has(nextCursor)) {
          throw new Error("OpenSea backfill cursor did not advance");
        }
        if (nextCursor) observedCursors.add(nextCursor);
        cursor = nextCursor;
        if (!cursor) break;
        if (page === this.#config.backfillPages - 1) {
          throw new Error(
            "OpenSea backfill is incomplete at the configured page limit",
          );
        }
      }
    }
  }

  async #fetchBackfillPage(url: URL, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#retryAttempts; attempt += 1) {
      let retryDelayMs = this.#retryBaseDelayMs * 2 ** (attempt - 1);
      const requestController = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        requestController.abort(
          new Error("OpenSea backfill request timed out"),
        );
      }, this.#requestTimeoutMs);
      const onAbort = () => {
        requestController.abort(
          signal?.reason ?? new Error("OpenSea backfill aborted"),
        );
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await this.#fetch(url, {
          headers: { "x-api-key": this.#config.apiKey },
          signal: requestController.signal,
        });
        if (response.ok || !isRetryableStatus(response.status)) return response;
        lastError = new Error(
          `OpenSea backfill retryable HTTP ${response.status}`,
        );
        retryDelayMs = Math.max(
          retryDelayMs,
          retryAfterDelayMs(response.headers.get("retry-after")),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = timedOut
          ? new Error("OpenSea backfill request timed out")
          : error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }

      if (attempt < this.#retryAttempts) {
        await this.#sleep(retryDelayMs, signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("OpenSea backfill request failed");
  }

  async start(sink: MarketEventSink): Promise<() => void> {
    const storagePath =
      process.env.OPENSEA_STREAM_STORAGE_PATH ?? ".opensea-stream";
    const client = new OpenSeaStreamClient({
      token: this.#config.apiKey,
      connectOptions: { transport: WebSocket, sessionStorage: LocalStorage },
    });
    // The SDK constructs LocalStorage internally; an explicit path keeps session state out of
    // source directories when the implementation requests it.
    process.env.NODE_LOCALSTORAGE = storagePath;
    const unsubscribe = this.#config.collectionSlugs.map((slug) =>
      client.onEvents(slug, [...STREAM_EVENTS], (event) => {
        void sink(normalizeOpenSeaEvent(event)).catch((error: unknown) => {
          console.error("OpenSea mirror event rejected", error);
        });
      }),
    );
    client.connect();
    return () => {
      for (const stop of unsubscribe) stop();
      client.disconnect();
    };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterDelayMs(value: string | null): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return 0;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return 0;
  return Math.min(seconds * 1_000, 30_000);
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
