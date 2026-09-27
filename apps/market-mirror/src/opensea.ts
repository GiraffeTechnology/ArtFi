import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { LocalStorage } from "node-localstorage";
import { EventType, OpenSeaStreamClient } from "@opensea/stream-js";
import { type RawData, WebSocket } from "ws";

import {
  MARKET_EVENT_SCHEMA_VERSION,
  type MarketEventFamily,
  type MarketEventSink,
  type MarketplaceBackfillLease,
  type MarketplaceBackfillOptions,
  type MarketSnapshotSink,
  type MarketplaceAdapter,
  type MarketplaceStreamLifecycle,
  type NormalizedMarketEvent,
} from "./adapter.js";

type UnknownRecord = Record<string, unknown>;

interface BackfillLock {
  ownerText: string;
}

interface BackfillLockOwner {
  schemaVersion: "1";
  pid: number;
  processInstance: string;
  token: string;
}

const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const MAX_PENDING_REALTIME_EVENTS = 256;
const MAX_PENDING_REALTIME_BYTES = 4 * 1024 * 1024;
const MAX_REALTIME_SPOOL_BYTES = 4 * 1024 * 1024;

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
  fetchImpl?: typeof fetch;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  spoolParentDirectory?: string;
  streamJoinTimeoutMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface BackfillCheckpoint {
  schemaVersion: "1";
  collectionsHash: string;
  collectionIndex: number;
  spoolBytes: number;
  nextCursor?: string;
  pageCollectionIndex?: number;
  pageFingerprints?: string[];
}

interface BackfillCheckpointState {
  checkpoints: BackfillCheckpoint[];
  validBytes: number;
}

type PhoenixFrame = [
  joinReference: unknown,
  reference: unknown,
  topic: unknown,
  event: unknown,
  payload: unknown,
];

export class OpenSeaJoinReadiness {
  readonly #topics: string[];
  readonly #promise: Promise<void>;
  readonly #timeoutMs: number;
  readonly #onReconnectReady?: () => Promise<void>;
  readonly #onFatal?: (error: unknown) => void;
  #pendingTopics: Set<string>;
  #timeout: ReturnType<typeof setTimeout>;
  #resolve!: () => void;
  #reject!: (reason?: unknown) => void;
  #settled = false;
  #generation = 0;

  constructor(
    collectionSlugs: string[],
    timeoutMs: number,
    onReconnectReady?: () => Promise<void>,
    onFatal?: (error: unknown) => void,
  ) {
    this.#topics = collectionSlugs.map((slug) => `collection:${slug}`);
    this.#pendingTopics = new Set(this.#topics);
    this.#timeoutMs = timeoutMs;
    this.#onReconnectReady = onReconnectReady;
    this.#onFatal = onFatal;
    this.#promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#timeout = this.#armTimeout(0);
  }

  beginConnection(): number {
    this.#generation += 1;
    this.#pendingTopics = new Set(this.#topics);
    clearTimeout(this.#timeout);
    this.#timeout = this.#armTimeout(this.#generation);
    return this.#generation;
  }

  observe(data: RawData, generation = this.#generation): void {
    if (generation !== this.#generation) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length !== 5) return;
    const frame = parsed as PhoenixFrame;
    const topic = typeof frame[2] === "string" ? frame[2] : undefined;
    if (!topic || !this.#pendingTopics.has(topic) || frame[3] !== "phx_reply") {
      return;
    }
    const payload = record(frame[4]);
    if (payload.status === "ok") {
      this.#pendingTopics.delete(topic);
      if (this.#pendingTopics.size === 0) this.#finish();
      return;
    }
    this.reject(new Error(`OpenSea stream subscription failed for ${topic}`));
  }

  reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timeout);
    this.#reject(
      reason instanceof Error
        ? reason
        : new Error("OpenSea stream subscription failed"),
    );
  }

  wait(): Promise<void> {
    return this.#promise;
  }

  #finish(): void {
    clearTimeout(this.#timeout);
    if (!this.#settled) {
      this.#settled = true;
      this.#resolve();
      return;
    }
    if (this.#generation === 0 || !this.#onReconnectReady) return;
    void this.#onReconnectReady().catch((error: unknown) => {
      this.#onFatal?.(error);
    });
  }

  #armTimeout(generation: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (generation !== this.#generation) return;
      const error = new Error("OpenSea stream subscription timed out");
      if (this.#settled) {
        this.#onFatal?.(error);
        return;
      }
      this.reject(error);
    }, this.#timeoutMs);
  }
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
  readonly #spoolParentDirectory?: string;
  readonly #streamJoinTimeoutMs: number;
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
    const streamJoinTimeoutMs = config.streamJoinTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(retryAttempts) ||
      retryAttempts < 1 ||
      retryAttempts > 5 ||
      !Number.isSafeInteger(retryBaseDelayMs) ||
      retryBaseDelayMs < 1 ||
      retryBaseDelayMs > 30_000 ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 120_000 ||
      !Number.isSafeInteger(streamJoinTimeoutMs) ||
      streamJoinTimeoutMs < 1 ||
      streamJoinTimeoutMs > 120_000
    ) {
      throw new Error("OpenSea backfill configuration is invalid");
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#retryAttempts = retryAttempts;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#spoolParentDirectory = config.spoolParentDirectory;
    this.#streamJoinTimeoutMs = streamJoinTimeoutMs;
    this.#sleep = config.sleep ?? sleepWithAbort;
  }

  async backfill(
    sink: MarketEventSink,
    signal?: AbortSignal,
    options?: MarketplaceBackfillOptions,
  ): Promise<void | MarketplaceBackfillLease> {
    const transientParent = this.#spoolParentDirectory
      ? undefined
      : await mkdtemp(join(tmpdir(), "artfi-opensea-backfill-"));
    const spoolParentDirectory = this.#spoolParentDirectory ?? transientParent!;
    await mkdir(spoolParentDirectory, { mode: 0o700, recursive: true });
    const collectionsHash = createHash("sha256")
      .update(JSON.stringify(this.#config.collectionSlugs))
      .digest("hex");
    const spoolDirectory = join(
      spoolParentDirectory,
      `snapshot-${collectionsHash.slice(0, 24)}`,
    );
    await mkdir(spoolDirectory, { mode: 0o700, recursive: true });
    const spoolPath = join(spoolDirectory, "events.ndjson");
    const checkpointPath = join(spoolDirectory, "checkpoints.ndjson");
    const lockPath = join(spoolDirectory, "active.lock");
    let lock: BackfillLock | undefined;
    let spool: Awaited<ReturnType<typeof open>> | undefined;
    let checkpointLog: Awaited<ReturnType<typeof open>> | undefined;
    let completed = false;
    let leaseActive = false;
    let finalization: Promise<void> | undefined;
    const finalizeBackfill = (removeSnapshot: boolean): Promise<void> => {
      finalization ??= (async () => {
        let cleanupFailure: unknown;
        if (removeSnapshot && !transientParent) {
          try {
            // Delete only the known snapshot payload while the writer lock is
            // still held. A successor cannot enter until release, and the
            // final rmdir is non-recursive so it cannot delete successor data.
            //
            // **Ordered, not concurrent.** `checkpoints.ndjson` is the pointer
            // and `events.ndjson` is the payload it names, so the pointer goes
            // first and the payload only once the pointer is gone. A crash
            // between the two, or a failure of the first unlink, can then leave
            // an orphaned payload — which the next start truncates and
            // re-derives — but never a pointer to a payload that no longer
            // exists. Removing them concurrently could leave either, and the
            // start path has no way to re-derive a payload it is told exists.
            await unlinkIfPresent(checkpointPath);
            await unlinkIfPresent(spoolPath);
          } catch (error) {
            cleanupFailure = error;
          }
        }
        try {
          if (lock) {
            await releaseBackfillLock(lockPath, lock);
            lock = undefined;
          }
        } catch (error) {
          cleanupFailure ??= error;
        }
        try {
          if (transientParent) {
            await rm(transientParent, { force: true, recursive: true });
          }
        } catch (error) {
          cleanupFailure ??= error;
        }
        if (cleanupFailure) throw cleanupFailure;
      })();
      return finalization;
    };
    try {
      lock = await acquireBackfillLock(lockPath);
      let checkpointState = await readBackfillCheckpoints(
        checkpointPath,
        collectionsHash,
        this.#config.collectionSlugs.length,
      );
      if (
        checkpointState.checkpoints.length > 0 &&
        !(await fileIsPresent(spoolPath))
      ) {
        // An orphaned pointer: cleanup was interrupted, or its first unlink
        // failed, after the payload went but before the checkpoint did. The
        // spool is staging and never an authority, so the answer is to discard
        // the checkpoint and re-derive the snapshot. Failing here instead left
        // the mirror unable to start until someone repaired the directory by
        // hand, which is a worse outcome than one repeated crawl. Zero valid
        // bytes truncates the stale checkpoint below, with the spool.
        checkpointState = { checkpoints: [], validBytes: 0 };
      }
      const checkpoints = checkpointState.checkpoints;
      const latest = checkpoints.at(-1);
      for (const path of [spoolPath, checkpointPath]) {
        const created = await open(path, "a", 0o600);
        await created.close();
      }
      const spoolState = await stat(spoolPath);
      const committedSpoolBytes = latest?.spoolBytes ?? 0;
      if (spoolState.size < committedSpoolBytes) {
        throw new Error(
          "OpenSea backfill spool is shorter than its checkpoint",
        );
      }
      await truncate(spoolPath, committedSpoolBytes);
      await truncate(checkpointPath, checkpointState.validBytes);
      spool = await open(spoolPath, "a+", 0o600);
      checkpointLog = await open(checkpointPath, "a+", 0o600);

      // A process can exit after a REST page is checkpointed but before the
      // realtime buffer is committed. Traverse each checkpointed collection
      // from its current head until the last committed page boundary is found.
      // This closes a crash window larger than one provider page without
      // retaining the transient realtime spool across process lifetimes.
      let resumedCollectionExhausted = false;
      if (latest) {
        // Every retained page counts, not just the last one written. The crawl
        // pages a collection from its head downwards, so the *first* checkpoint
        // for a collection is its newest page and the last is its oldest.
        // Keeping only one of them kept the oldest, and the traversal below then
        // re-appended nearly the whole committed history before it recognised
        // anything — a spool that fit once but not twice hit ENOSPC on every
        // retry. Every fingerprint here lies inside the committed region: the
        // spool was just truncated to the newest checkpoint's `spoolBytes`,
        // which is at or past every earlier checkpoint's. Stopping at the first
        // match is therefore safe as well as cheapest: the crawl is contiguous
        // newest-first, so everything older than a committed event is either
        // already in the spool or still behind the saved cursor.
        const boundaryByCollection = new Map<number, Set<string>>();
        for (const checkpoint of checkpoints) {
          if (
            checkpoint.pageCollectionIndex === undefined ||
            !checkpoint.pageFingerprints
          ) {
            continue;
          }
          let boundary = boundaryByCollection.get(
            checkpoint.pageCollectionIndex,
          );
          if (!boundary) {
            boundary = new Set<string>();
            boundaryByCollection.set(checkpoint.pageCollectionIndex, boundary);
          }
          for (const fingerprint of checkpoint.pageFingerprints) {
            boundary.add(fingerprint);
          }
        }
        const checkpointedCollectionCount = latest.nextCursor
          ? latest.collectionIndex + 1
          : latest.collectionIndex;
        for (
          let overlapCollectionIndex = 0;
          overlapCollectionIndex < checkpointedCollectionCount;
          overlapCollectionIndex += 1
        ) {
          const slug = this.#config.collectionSlugs[overlapCollectionIndex]!;
          const boundary = boundaryByCollection.get(overlapCollectionIndex);
          const observedOverlapCursors = new Set<string>();
          let overlapCursor: string | undefined;
          let boundaryReached = false;
          while (!boundaryReached) {
            const overlapUrl = new URL(
              `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}`,
            );
            overlapUrl.searchParams.set("limit", "200");
            if (overlapCursor) {
              overlapUrl.searchParams.set("next", overlapCursor);
            }
            const overlap = await this.#fetchBackfillPage(overlapUrl, signal);
            const overlapEvents = Array.isArray(overlap.asset_events)
              ? overlap.asset_events.map(normalizeOpenSeaEvent)
              : [];
            for (const event of overlapEvents) {
              if (boundary?.has(eventFingerprint(event))) {
                boundaryReached = true;
                break;
              }
              await writeAll(spool, `${JSON.stringify(event)}\n`);
            }
            if (boundaryReached) break;
            const nextCursor = text(overlap.next);
            if (!nextCursor) {
              if (
                latest.nextCursor &&
                overlapCollectionIndex === latest.collectionIndex
              ) {
                resumedCollectionExhausted = true;
              }
              break;
            }
            if (observedOverlapCursors.has(nextCursor)) {
              throw new Error(
                "OpenSea recovery overlap cursor did not advance",
              );
            }
            observedOverlapCursors.add(nextCursor);
            overlapCursor = nextCursor;
          }
        }
        await spool.sync();
      }

      let collectionIndex = latest?.collectionIndex ?? 0;
      let cursor = latest?.nextCursor;
      if (resumedCollectionExhausted) {
        collectionIndex += 1;
        cursor = undefined;
      }
      while (collectionIndex < this.#config.collectionSlugs.length) {
        const slug = this.#config.collectionSlugs[collectionIndex]!;
        const observedCursors = new Set(
          checkpoints
            .filter((item) => item.collectionIndex === collectionIndex)
            .map((item) => item.nextCursor)
            .filter((item): item is string => item !== undefined),
        );
        while (collectionIndex < this.#config.collectionSlugs.length) {
          const url = new URL(
            `https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}`,
          );
          url.searchParams.set("limit", "200");
          if (cursor) url.searchParams.set("next", cursor);
          const body = await this.#fetchBackfillPage(url, signal);
          const events = Array.isArray(body.asset_events)
            ? body.asset_events.map(normalizeOpenSeaEvent)
            : [];
          for (const event of events) {
            await writeAll(spool, `${JSON.stringify(event)}\n`);
          }
          await spool.sync();
          const spoolBytes = (await spool.stat()).size;

          const nextCursor = text(body.next);
          if (nextCursor && observedCursors.has(nextCursor)) {
            throw new Error("OpenSea backfill cursor did not advance");
          }
          if (nextCursor) observedCursors.add(nextCursor);
          const nextCheckpoint: BackfillCheckpoint = {
            schemaVersion: "1",
            collectionsHash,
            collectionIndex: nextCursor ? collectionIndex : collectionIndex + 1,
            spoolBytes,
            ...(nextCursor ? { nextCursor } : {}),
            ...(events.length > 0
              ? {
                  pageCollectionIndex: collectionIndex,
                  pageFingerprints: events.map(eventFingerprint),
                }
              : {}),
          };
          await writeAll(checkpointLog, `${JSON.stringify(nextCheckpoint)}\n`);
          await checkpointLog.sync();
          checkpoints.push(nextCheckpoint);
          cursor = nextCursor;
          if (cursor) continue;
          collectionIndex += 1;
          cursor = undefined;
          break;
        }
      }
      await spool.sync();
      await spool.close();
      spool = undefined;
      const deferredLease: MarketplaceBackfillLease | undefined =
        options?.deferFinalize
          ? {
              commit: async () => {
                leaseActive = false;
                await finalizeBackfill(true);
              },
              abort: async () => {
                leaseActive = false;
                await finalizeBackfill(false);
              },
            }
          : undefined;
      if (deferredLease && options?.onLeaseReady) {
        leaseActive = true;
        try {
          options.onLeaseReady(deferredLease);
        } catch (error) {
          leaseActive = false;
          throw error;
        }
      }
      await options?.onSourceSealed?.();
      const input = createReadStream(spoolPath, { encoding: "utf8" });
      const lines = createInterface({
        input,
        crlfDelay: Infinity,
      });
      try {
        for await (const line of lines) {
          if (line !== "") {
            await sink(JSON.parse(line) as NormalizedMarketEvent);
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
      completed = true;
      if (deferredLease) {
        leaseActive = true;
        return deferredLease;
      }
    } finally {
      await spool?.close();
      await checkpointLog?.close();
      if (!leaseActive) {
        await finalizeBackfill(completed || transientParent !== undefined);
      }
    }
  }

  async #fetchBackfillPage(
    url: URL,
    signal?: AbortSignal,
  ): Promise<UnknownRecord> {
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
        if (!response.ok) {
          if (!isRetryableStatus(response.status)) {
            throw new PermanentBackfillError(
              `OpenSea backfill failed with HTTP ${response.status}`,
            );
          }
          lastError = new Error(
            `OpenSea backfill retryable HTTP ${response.status}`,
          );
          retryDelayMs = Math.max(
            retryDelayMs,
            retryAfterDelayMs(response.headers.get("retry-after")),
          );
        } else {
          return record(await response.json());
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof PermanentBackfillError) throw error;
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

  async start(
    sink: MarketEventSink,
    lifecycle?: MarketplaceStreamLifecycle,
  ): Promise<() => void> {
    const storagePath =
      process.env.OPENSEA_STREAM_STORAGE_PATH ?? ".opensea-stream";
    const readiness = new OpenSeaJoinReadiness(
      this.#config.collectionSlugs,
      this.#streamJoinTimeoutMs,
      lifecycle?.onReconnectReady,
      lifecycle?.onFatal,
    );
    class AcknowledgedOpenSeaWebSocket extends WebSocket {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols);
        const generation = readiness.beginConnection();
        this.on("message", (data) => readiness.observe(data, generation));
      }
    }
    const client = new OpenSeaStreamClient({
      token: this.#config.apiKey,
      connectOptions: {
        transport: AcknowledgedOpenSeaWebSocket,
        sessionStorage: LocalStorage,
      },
      onError: (error) => readiness.reject(error),
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
    try {
      await readiness.wait();
    } catch (error) {
      for (const stop of unsubscribe) stop();
      client.disconnect();
      throw error;
    }
    return () => {
      for (const stop of unsubscribe) stop();
      client.disconnect();
    };
  }
}

async function readBackfillCheckpoints(
  checkpointPath: string,
  collectionsHash: string,
  collectionCount: number,
): Promise<BackfillCheckpointState> {
  let contents: Buffer;
  try {
    contents = await readFile(checkpointPath);
  } catch (error) {
    if (isMissingFile(error)) return { checkpoints: [], validBytes: 0 };
    throw error;
  }
  const finalNewline = contents.lastIndexOf(0x0a);
  const validBytes = finalNewline + 1;
  const completeContents = contents.subarray(0, validBytes).toString("utf8");
  const checkpoints: BackfillCheckpoint[] = [];
  for (const line of completeContents.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("OpenSea backfill checkpoint is invalid");
    }
    const value = record(parsed);
    const nextCursor = text(value.nextCursor);
    const pageCollectionIndex = value.pageCollectionIndex;
    const pageFingerprints = Array.isArray(value.pageFingerprints)
      ? value.pageFingerprints
      : undefined;
    const hasPageBoundary =
      pageCollectionIndex !== undefined || pageFingerprints !== undefined;
    if (
      value.schemaVersion !== "1" ||
      value.collectionsHash !== collectionsHash ||
      !Number.isSafeInteger(value.collectionIndex) ||
      (value.collectionIndex as number) < 0 ||
      (value.collectionIndex as number) > collectionCount ||
      !Number.isSafeInteger(value.spoolBytes) ||
      (value.spoolBytes as number) < 0 ||
      (value.nextCursor !== undefined && nextCursor === undefined) ||
      ((value.collectionIndex as number) === collectionCount && nextCursor) ||
      (hasPageBoundary &&
        (!Number.isSafeInteger(pageCollectionIndex) ||
          (pageCollectionIndex as number) < 0 ||
          (pageCollectionIndex as number) >= collectionCount ||
          !pageFingerprints ||
          pageFingerprints.length < 1 ||
          pageFingerprints.length > 200 ||
          pageFingerprints.some(
            (item) => typeof item !== "string" || !/^[0-9a-f]{64}$/.test(item),
          )))
    ) {
      throw new Error("OpenSea backfill checkpoint is invalid");
    }
    const checkpoint: BackfillCheckpoint = {
      schemaVersion: "1",
      collectionsHash,
      collectionIndex: value.collectionIndex as number,
      spoolBytes: value.spoolBytes as number,
      ...(nextCursor ? { nextCursor } : {}),
      ...(hasPageBoundary
        ? {
            pageCollectionIndex: pageCollectionIndex as number,
            pageFingerprints: pageFingerprints as string[],
          }
        : {}),
    };
    const previous = checkpoints.at(-1);
    if (
      previous &&
      (checkpoint.spoolBytes < previous.spoolBytes ||
        (checkpoint.collectionIndex !== previous.collectionIndex &&
          checkpoint.collectionIndex !== previous.collectionIndex + 1))
    ) {
      throw new Error("OpenSea backfill checkpoint sequence is invalid");
    }
    checkpoints.push(checkpoint);
  }
  return { checkpoints, validBytes };
}

function isMissingFile(error: unknown): boolean {
  return record(error).code === "ENOENT";
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function fileIsPresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function acquireBackfillLock(lockPath: string): Promise<BackfillLock> {
  const owner: BackfillLockOwner = {
    schemaVersion: "1",
    pid: process.pid,
    processInstance: await readProcessInstance(process.pid),
    token: randomUUID(),
  };
  const ownerText = `${JSON.stringify(owner)}\n`;
  const candidatePath = `${lockPath}.${owner.token}.candidate`;
  const reclaimPath = `${lockPath}.reclaim`;

  for (;;) {
    if (!(await removeStaleReclaimMarker(lockPath))) {
      throw fileExistsError(lockPath);
    }

    let candidate: Awaited<ReturnType<typeof open>> | undefined;
    try {
      candidate = await open(candidatePath, "wx", 0o600);
      await candidate.writeFile(ownerText);
      await candidate.sync();
      await candidate.close();
      candidate = undefined;
      await link(candidatePath, lockPath);
      return { ownerText };
    } catch (error) {
      if (record(error).code !== "EEXIST") throw error;
      if (
        !(await removeStaleBackfillLock(lockPath, candidatePath, ownerText))
      ) {
        throw error;
      }
    } finally {
      await candidate?.close();
      await unlink(candidatePath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    }
  }
}

async function removeStaleReclaimMarker(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  let ownerText: string;
  try {
    ownerText = await readFile(reclaimPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }

  const owner = parseBackfillLockOwner(ownerText);
  if (!owner || (await backfillLockOwnerIsLive(owner))) return false;
  try {
    await unlink(reclaimPath);
    if ("token" in owner) {
      await unlink(`${lockPath}.${owner.token}.candidate`).catch(
        (error: unknown) => {
          if (!isMissingFile(error)) throw error;
        },
      );
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return true;
}

async function removeStaleBackfillLock(
  lockPath: string,
  candidatePath: string,
  reclaimerText: string,
): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  let observedOwnerText: string;
  let observedLock: Awaited<ReturnType<typeof stat>>;
  try {
    [observedOwnerText, observedLock] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }

  const observedOwner = parseBackfillLockOwner(observedOwnerText);
  if (!observedOwner || (await backfillLockOwnerIsLive(observedOwner))) {
    return false;
  }

  try {
    await link(candidatePath, reclaimPath);
  } catch (error) {
    if (isMissingFile(error)) return true;
    if (record(error).code === "EEXIST") return false;
    throw error;
  }

  try {
    if ((await readFile(reclaimPath, "utf8")) !== reclaimerText) {
      return false;
    }
    const [currentOwnerText, current] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    if (
      currentOwnerText !== observedOwnerText ||
      current.dev !== observedLock.dev ||
      current.ino !== observedLock.ino
    ) {
      return true;
    }
    await unlink(lockPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  } finally {
    try {
      if ((await readFile(reclaimPath, "utf8")) === reclaimerText) {
        await unlink(reclaimPath);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return true;
}

async function releaseBackfillLock(
  lockPath: string,
  lock: BackfillLock,
): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== lock.ownerText) return;
    await unlink(lockPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function parseBackfillLockOwner(
  ownerText: string,
): BackfillLockOwner | { pid: number } | undefined {
  const normalizedOwner = ownerText.trim();
  if (/^[1-9][0-9]*$/.test(normalizedOwner)) {
    const pid = Number(normalizedOwner);
    return Number.isSafeInteger(pid) ? { pid } : undefined;
  }
  try {
    const candidate = JSON.parse(normalizedOwner) as UnknownRecord;
    if (
      candidate.schemaVersion !== "1" ||
      !Number.isSafeInteger(candidate.pid) ||
      typeof candidate.processInstance !== "string" ||
      candidate.processInstance === "" ||
      typeof candidate.token !== "string" ||
      candidate.token === ""
    ) {
      return undefined;
    }
    return candidate as unknown as BackfillLockOwner;
  } catch {
    return undefined;
  }
}

async function backfillLockOwnerIsLive(
  owner: BackfillLockOwner | { pid: number },
): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return record(error).code !== "ESRCH";
  }
  if (!("processInstance" in owner)) return true;
  if (process.platform !== "linux" && owner.pid !== process.pid) return true;
  return (await readProcessInstance(owner.pid)) === owner.processInstance;
}

async function readProcessInstance(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const [bootId, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = processStat.lastIndexOf(")");
    const statFields = processStat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTicks = statFields[19];
    if (commandEnd < 0 || !startTicks) {
      throw new Error("Unable to read process instance identity");
    }
    return `linux:${bootId.trim()}:${startTicks}`;
  }
  if (pid !== process.pid) {
    throw new Error("External process identity is unavailable");
  }
  return `${process.platform}:${PROCESS_STARTED_AT_MS}`;
}

function fileExistsError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Backfill lock already exists: ${path}`), {
    code: "EEXIST",
  });
}

function isBackfillLease(value: unknown): value is MarketplaceBackfillLease {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MarketplaceBackfillLease>;
  return (
    typeof candidate.commit === "function" &&
    typeof candidate.abort === "function"
  );
}

function createSnapshotHandoff(): {
  events: AsyncIterable<NormalizedMarketEvent>;
  push(event: NormalizedMarketEvent): Promise<void>;
  close(): void;
  fail(error: unknown): void;
} {
  interface Slot {
    event: NormalizedMarketEvent;
    resolve(): void;
    reject(error: unknown): void;
  }
  let slot: Slot | undefined;
  let inFlight: Slot | undefined;
  let wakeConsumer: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  let consumerEnded = false;
  const wake = (): void => {
    wakeConsumer?.();
    wakeConsumer = undefined;
  };
  const rejectSlot = (target: Slot | undefined, error: unknown): void => {
    target?.reject(error);
  };
  const events: AsyncIterable<NormalizedMarketEvent> = {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          while (!slot && !closed && failure === undefined) {
            await new Promise<void>((resolve) => {
              wakeConsumer = resolve;
            });
          }
          if (failure !== undefined) throw failure;
          if (!slot) return;
          const current = slot;
          slot = undefined;
          inFlight = current;
          yield current.event;
          current.resolve();
          if (inFlight === current) inFlight = undefined;
        }
      } finally {
        consumerEnded = true;
        const error =
          failure ?? new Error("OpenSea snapshot consumer ended early");
        rejectSlot(inFlight, error);
        inFlight = undefined;
        rejectSlot(slot, error);
        slot = undefined;
        wake();
      }
    },
  };
  return {
    events,
    push(event) {
      if (failure !== undefined) return Promise.reject(failure);
      if (closed || consumerEnded) {
        return Promise.reject(
          new Error("OpenSea snapshot consumer is not accepting events"),
        );
      }
      if (slot || inFlight) {
        return Promise.reject(
          new Error("OpenSea snapshot handoff capacity exceeded"),
        );
      }
      const acknowledgement = new Promise<void>((resolve, reject) => {
        slot = { event, resolve, reject };
      });
      wake();
      return acknowledgement;
    },
    close() {
      closed = true;
      wake();
    },
    fail(error) {
      failure ??= error;
      closed = true;
      rejectSlot(slot, failure);
      slot = undefined;
      rejectSlot(inFlight, failure);
      inFlight = undefined;
      wake();
    },
  };
}

export async function startOpenSeaMirror(
  adapter: MarketplaceAdapter,
  sink: MarketEventSink,
  snapshotSink: MarketSnapshotSink,
  onFatal: (error: unknown) => void = () => undefined,
): Promise<() => void> {
  const realtimeDirectory = await mkdtemp(
    join(tmpdir(), "artfi-opensea-realtime-"),
  );
  const precommitPath = join(realtimeDirectory, "precommit.ndjson");
  const postcommitPath = join(realtimeDirectory, "postcommit.ndjson");
  let precommitBuffer: Awaited<ReturnType<typeof open>> | undefined;
  let postcommitBuffer: Awaited<ReturnType<typeof open>> | undefined;
  let realtimePhase: "precommit" | "postcommit" | "draining" | "ready" =
    "precommit";
  let precommitFailure: unknown;
  let postcommitFailure: unknown;
  const snapshotController = new AbortController();
  // The REST crawl needs its own abort signal. Aborting the snapshot upload
  // stops the *publication* of what has been staged; it does nothing to a crawl
  // that is still fetching pages, and the crawl holds the durable writer lock
  // while it does. Without this, a fatal stream condition — a reconnect
  // acknowledgement that times out — could not end a long traversal, so
  // recovery waited for every remaining page of a history it was about to throw
  // away.
  const crawlController = new AbortController();
  const failRealtime = (
    error: unknown,
    phase: "precommit" | "postcommit" | "draining" | "ready",
  ): void => {
    if (phase === "precommit") {
      precommitFailure ??= error;
      if (!snapshotController.signal.aborted) {
        snapshotController.abort(error);
      }
      return;
    }
    postcommitFailure ??= error;
  };
  let realtimeSequence = Promise.resolve();
  let pendingRealtimeEvents = 0;
  let pendingRealtimeBytes = 0;
  const retainedRealtimeBytes = { precommit: 0, postcommit: 0 };
  let reconnectSequence = Promise.resolve();
  let backfillFailure: unknown;
  let releaseInitialCommit!: () => void;
  const initialCommit = new Promise<void>((resolve) => {
    releaseInitialCommit = resolve;
  });
  const scheduleBackfill = (): Promise<void> => {
    const next = reconnectSequence.then(async () => {
      await initialCommit;
      if (backfillFailure) throw backfillFailure;
      const result = await adapter.backfill(sink, crawlController.signal);
      if (isBackfillLease(result)) await result.commit();
    });
    reconnectSequence = next.catch((error: unknown) => {
      backfillFailure ??= error;
    });
    return next;
  };
  try {
    precommitBuffer = await open(precommitPath, "wx+", 0o600);
  } catch (error) {
    await precommitBuffer?.close();
    await rm(realtimeDirectory, { force: true, recursive: true });
    throw error;
  }
  const realtimeSink: MarketEventSink = (event) => {
    const writePhase = realtimePhase;
    const spoolPhase =
      writePhase === "precommit" || writePhase === "postcommit"
        ? writePhase
        : undefined;
    const serialized =
      writePhase === "precommit" || writePhase === "postcommit"
        ? `${JSON.stringify(event)}\n`
        : undefined;
    const serializedBytes = serialized
      ? Buffer.byteLength(serialized, "utf8")
      : 0;
    const retainedBytes = spoolPhase ? retainedRealtimeBytes[spoolPhase] : 0;
    if (
      serialized &&
      (pendingRealtimeEvents >= MAX_PENDING_REALTIME_EVENTS ||
        pendingRealtimeBytes + serializedBytes > MAX_PENDING_REALTIME_BYTES ||
        retainedBytes + serializedBytes > MAX_REALTIME_SPOOL_BYTES)
    ) {
      const error = new Error(
        "OpenSea pre-snapshot realtime queue capacity exceeded",
      );
      failRealtime(error, writePhase);
      return Promise.reject(error);
    }
    if (serialized) {
      pendingRealtimeEvents += 1;
      pendingRealtimeBytes += serializedBytes;
      retainedRealtimeBytes[spoolPhase!] += serializedBytes;
    }
    const targetBuffer =
      writePhase === "precommit" ? precommitBuffer : postcommitBuffer;
    const next = realtimeSequence
      .then(async () => {
        const failure =
          writePhase === "precommit" ? precommitFailure : postcommitFailure;
        if (serialized && failure) throw failure;
        if (serialized) {
          await writeAll(targetBuffer!, serialized);
          await targetBuffer!.sync();
          return;
        }
        await sink(event);
      })
      .finally(() => {
        if (serialized) {
          pendingRealtimeEvents -= 1;
          pendingRealtimeBytes -= serializedBytes;
        }
      });
    realtimeSequence = next.catch((error: unknown) => {
      if (writePhase === "precommit" || writePhase === "postcommit") {
        failRealtime(error, writePhase);
      }
    });
    return next;
  };
  let sealPrecommitRun: Promise<void> | undefined;
  const sealPrecommit = (): Promise<void> => {
    sealPrecommitRun ??= (async () => {
      await realtimeSequence;
      if (precommitFailure) throw precommitFailure;
      postcommitBuffer = await open(postcommitPath, "wx+", 0o600);
      realtimePhase = "postcommit";
      await realtimeSequence;
      if (precommitFailure) throw precommitFailure;
      await precommitBuffer!.sync();
      await precommitBuffer!.close();
      precommitBuffer = undefined;
    })();
    return sealPrecommitRun;
  };
  const snapshotHandoff = createSnapshotHandoff();
  let snapshotRun: Promise<void> | undefined;
  const ensureSnapshotStarted = (): Promise<void> => {
    if (!snapshotRun) {
      snapshotRun = Promise.resolve()
        .then(() =>
          snapshotSink(snapshotHandoff.events, snapshotController.signal),
        )
        .catch((error: unknown) => {
          snapshotHandoff.fail(error);
          throw error;
        });
      void snapshotRun.catch(() => undefined);
    }
    return snapshotRun;
  };
  const stageSnapshot: MarketEventSink = async (event) => {
    await sealPrecommit();
    if (precommitFailure) throw precommitFailure;
    void ensureSnapshotStarted();
    await snapshotHandoff.push(event);
  };
  const stagedEvents = async function* (
    paths: string[],
  ): AsyncGenerator<NormalizedMarketEvent> {
    for (const path of paths) {
      const input = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line !== "") {
            yield JSON.parse(line) as NormalizedMarketEvent;
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
  };
  let backfillLease: MarketplaceBackfillLease | undefined;
  let stop: (() => void) | undefined;
  try {
    stop = await adapter.start(realtimeSink, {
      onReconnectReady: scheduleBackfill,
      onFatal: (error) => {
        failRealtime(error, realtimePhase);
        if (!crawlController.signal.aborted) crawlController.abort(error);
        stop?.();
        onFatal(error);
      },
    });
    const initialBackfill = await adapter.backfill(
      stageSnapshot,
      crawlController.signal,
      {
        deferFinalize: true,
        onLeaseReady: (lease) => {
          backfillLease = lease;
        },
        onSourceSealed: sealPrecommit,
      },
    );
    if (isBackfillLease(initialBackfill)) backfillLease ??= initialBackfill;
    await sealPrecommit();
    for await (const event of stagedEvents([precommitPath])) {
      void ensureSnapshotStarted();
      await snapshotHandoff.push(event);
    }
    const completedSnapshot = ensureSnapshotStarted();
    snapshotHandoff.close();
    await completedSnapshot;
    await backfillLease?.commit();
    backfillLease = undefined;

    await realtimeSequence;
    if (postcommitFailure) throw postcommitFailure;
    realtimePhase = "draining";
    const drainRealtime = realtimeSequence.then(async () => {
      await postcommitBuffer!.sync();
      await postcommitBuffer!.close();
      postcommitBuffer = undefined;
      for await (const event of stagedEvents([postcommitPath])) {
        await sink(event);
      }
    });
    realtimeSequence = drainRealtime.catch(() => undefined);
    await drainRealtime;
    realtimePhase = "ready";
    await realtimeSequence;
    releaseInitialCommit();
    return stop;
  } catch (error) {
    snapshotHandoff.fail(error);
    await snapshotRun?.catch(() => undefined);
    let terminalError = error;
    if (backfillLease) {
      try {
        await backfillLease.abort();
      } catch (abortError) {
        terminalError = new AggregateError(
          [error, abortError],
          "OpenSea snapshot failed and its backfill lease could not abort",
        );
      }
      backfillLease = undefined;
    }
    stop?.();
    throw terminalError;
  } finally {
    if (!snapshotController.signal.aborted) {
      snapshotController.abort(new Error("OpenSea snapshot lifecycle ended"));
    }
    await precommitBuffer?.close();
    await postcommitBuffer?.close();
    await rm(realtimeDirectory, { force: true, recursive: true });
  }
}

export async function writeAll(
  file: Pick<FileHandle, "write">,
  value: string,
): Promise<void> {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("Durable backfill log write made no progress");
    }
    offset += bytesWritten;
  }
}

class PermanentBackfillError extends Error {}

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
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
