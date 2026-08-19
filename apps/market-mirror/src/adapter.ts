export const MARKET_EVENT_SCHEMA_VERSION = "1" as const;

export type MarketEventFamily = "order" | "sale" | "transfer" | "metadata";

export interface NormalizedMarketEvent {
  schemaVersion: typeof MARKET_EVENT_SCHEMA_VERSION;
  source: string;
  eventType: string;
  eventFamily: MarketEventFamily;
  entityKey: string;
  version: number;
  chain: string;
  collectionSlug?: string;
  orderHash?: string;
  transactionHash?: string;
  contractAddress?: string;
  tokenId?: string;
  makerAddress?: string;
  price?: string;
  paymentTokenAddress?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
  eventTimestamp: string;
  payload: Record<string, unknown>;
}

export interface MarketplaceCapabilities {
  realtime: boolean;
  restBackfill: boolean;
  createsOrders: false;
  fulfillsOrders: false;
  custody: false;
}

export type MarketEventSink = (event: NormalizedMarketEvent) => Promise<void>;

export interface MarketplaceAdapter {
  readonly source: string;
  readonly capabilities: MarketplaceCapabilities;
  backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void>;
  start(sink: MarketEventSink): Promise<() => void>;
}
