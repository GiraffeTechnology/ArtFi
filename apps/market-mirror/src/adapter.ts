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

export type MarketplaceHealthState =
  "starting" | "healthy" | "degraded" | "stale" | "stopped";

export interface MarketplaceHealthSnapshot {
  schemaVersion: "1";
  source: string;
  state: MarketplaceHealthState;
  stale: boolean;
  realtimeConnected: boolean;
  consecutiveFailures: number;
  observedAt: string;
  lastBackfillSuccessAt?: string;
  lastEventAt?: string;
  lastFailureAt?: string;
  freshnessLagSeconds?: number;
  staleAfterSeconds: number;
}

export class MarketplaceHealthTracker {
  readonly #source: string;
  readonly #staleAfterMs: number;
  readonly #now: () => Date;
  #started = false;
  #realtimeConnected = false;
  #consecutiveFailures = 0;
  #lastBackfillSuccessAt?: Date;
  #lastEventAt?: Date;
  #lastFailureAt?: Date;

  constructor(source: string, staleAfterMs: number, now = () => new Date()) {
    if (
      !source ||
      !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 1_000 ||
      staleAfterMs % 1_000 !== 0
    ) {
      throw new Error("Marketplace health configuration is invalid");
    }
    this.#source = source;
    this.#staleAfterMs = staleAfterMs;
    this.#now = now;
  }

  start(): void {
    this.#started = true;
  }

  markBackfillSuccess(): void {
    this.#started = true;
    this.#lastBackfillSuccessAt = this.#now();
    this.#consecutiveFailures = 0;
  }

  markEvent(): void {
    this.#started = true;
    this.#realtimeConnected = true;
    this.#lastEventAt = this.#now();
    this.#consecutiveFailures = 0;
  }

  markFailure(): void {
    this.#started = true;
    this.#lastFailureAt = this.#now();
    this.#consecutiveFailures += 1;
  }

  markRealtimeFailure(): void {
    this.#realtimeConnected = false;
    this.markFailure();
  }

  stop(): void {
    this.#started = false;
    this.#realtimeConnected = false;
  }

  snapshot(observedAt = this.#now()): MarketplaceHealthSnapshot {
    const freshnessReference = latest(
      this.#lastBackfillSuccessAt,
      this.#lastEventAt,
    );
    const freshnessLagMs = freshnessReference
      ? Math.max(0, observedAt.getTime() - freshnessReference.getTime())
      : undefined;
    const stale =
      freshnessLagMs === undefined || freshnessLagMs > this.#staleAfterMs;
    let state: MarketplaceHealthState = "starting";
    if (!this.#started) state = "stopped";
    else if (this.#consecutiveFailures > 0) state = "degraded";
    else if (!freshnessReference) state = "starting";
    else if (stale) state = "stale";
    else state = "healthy";

    return {
      schemaVersion: "1",
      source: this.#source,
      state,
      stale,
      realtimeConnected: this.#realtimeConnected,
      consecutiveFailures: this.#consecutiveFailures,
      observedAt: observedAt.toISOString(),
      lastBackfillSuccessAt: this.#lastBackfillSuccessAt?.toISOString(),
      lastEventAt: this.#lastEventAt?.toISOString(),
      lastFailureAt: this.#lastFailureAt?.toISOString(),
      freshnessLagSeconds:
        freshnessLagMs === undefined
          ? undefined
          : Math.floor(freshnessLagMs / 1_000),
      staleAfterSeconds: this.#staleAfterMs / 1_000,
    };
  }
}

function latest(first?: Date, second?: Date): Date | undefined {
  if (!first) return second;
  if (!second) return first;
  return first.getTime() >= second.getTime() ? first : second;
}

export type MarketEventSink = (event: NormalizedMarketEvent) => Promise<void>;

export interface MarketplaceAdapter {
  readonly source: string;
  readonly capabilities: MarketplaceCapabilities;
  backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void>;
  start(sink: MarketEventSink): Promise<() => void>;
  health(now?: Date): MarketplaceHealthSnapshot;
}
