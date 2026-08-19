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

  constructor(config: OpenSeaAdapterConfig) {
    if (!config.apiKey || config.collectionSlugs.length === 0) {
      throw new Error(
        "OpenSea API key and at least one collection slug are required",
      );
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  async backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void> {
    for (const slug of this.#config.collectionSlugs) {
      let cursor: string | undefined;
      for (let page = 0; page < this.#config.backfillPages; page += 1) {
        const url = new URL(
          `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}`,
        );
        url.searchParams.set("limit", "200");
        if (cursor) url.searchParams.set("next", cursor);
        const response = await this.#fetch(url, {
          headers: { "x-api-key": this.#config.apiKey },
          signal,
        });
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
        cursor = text(body.next);
        if (!cursor) break;
      }
    }
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
