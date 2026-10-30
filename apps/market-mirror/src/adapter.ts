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
}

export class MarketplaceHealthTracker {
  readonly #source: string;
  readonly #staleAfterMs: number;
  readonly #now: () => Date;
  #started = false;
  #epoch = 0;
  #connectionGeneration = 0;
  #realtimeFailed = false;
  #realtimeConnected = false;
  #consecutiveFailures = 0;
  #lastBackfillSuccessAt?: Date;
  #lastEventAt?: Date;
  #lastFailureAt?: Date;

  constructor(source: string, staleAfterMs: number, now = () => new Date()) {
    if (
      !source ||
      !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 1_000
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

  beginWork(): number {
    this.start();
    return this.#epoch;
  }

  beginConnection(): number {
    this.start();
    this.#realtimeConnected = false;
    return ++this.#connectionGeneration;
  }

  markRealtimeReady(generation: number): void {
    if (!this.#started || generation !== this.#connectionGeneration) return;
    this.#realtimeConnected = true;
    this.#realtimeFailed = false;
    this.#consecutiveFailures = 0;
  }

  markRealtimeFailure(generation: number): void {
    if (!this.#started || generation !== this.#connectionGeneration) return;
    this.#connectionGeneration++;
    this.#realtimeConnected = false;
    this.#realtimeFailed = true;
    this.markFailure();
  }

  markBackfillSuccess(epoch = this.#epoch): void {
    if (!this.#started || epoch !== this.#epoch) return;
    this.#lastBackfillSuccessAt = new Date(this.#now().getTime());
    if (!this.#realtimeFailed) this.#consecutiveFailures = 0;
  }

  markEvent(generation: number): void {
    if (
      !this.#started ||
      !this.#realtimeConnected ||
      generation !== this.#connectionGeneration
    )
      return;
    this.#lastEventAt = new Date(this.#now().getTime());
    this.#consecutiveFailures = 0;
  }

  markEventFailure(generation: number): void {
    if (!this.#started || generation !== this.#connectionGeneration) return;
    this.markFailure();
  }

  markFailure(epoch = this.#epoch): void {
    if (!this.#started || epoch !== this.#epoch) return;
    this.#lastFailureAt = new Date(this.#now().getTime());
    this.#consecutiveFailures += 1;
  }

  stop(): void {
    this.#epoch++;
    this.#connectionGeneration++;
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
    else if (this.#consecutiveFailures > 0 || this.#realtimeFailed)
      state = "degraded";
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
    };
  }
}

function latest(first?: Date, second?: Date): Date | undefined {
  if (!first) return second;
  if (!second) return first;
  return first.getTime() >= second.getTime() ? first : second;
}

export type MarketEventSink = (event: NormalizedMarketEvent) => Promise<void>;

export type MarketSnapshotSink = (
  events: AsyncIterable<NormalizedMarketEvent>,
  signal: AbortSignal,
) => Promise<void>;

export interface MarketplaceBackfillLease {
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface MarketplaceBackfillOptions {
  deferFinalize?: boolean;
  onLeaseReady?(lease: MarketplaceBackfillLease): void;
  onSourceSealed?(): Promise<void>;
}

export interface MarketplaceStreamLifecycle {
  onReconnectReady(): Promise<void>;
  onFatal(error: unknown): void;
}

export interface MarketplaceAdapter {
  readonly source: string;
  readonly capabilities: MarketplaceCapabilities;
  health?(now?: Date): MarketplaceHealthSnapshot;
  backfill(
    sink: MarketEventSink,
    signal?: AbortSignal,
    options?: MarketplaceBackfillOptions,
  ): Promise<void | MarketplaceBackfillLease>;
  start(
    sink: MarketEventSink,
    lifecycle?: MarketplaceStreamLifecycle,
  ): Promise<() => void>;
}
