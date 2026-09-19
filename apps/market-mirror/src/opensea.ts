import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
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
  type MarketplaceAdapter,
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
  nextCursor?: string;
}

type PhoenixFrame = [
  joinReference: unknown,
  reference: unknown,
  topic: unknown,
  event: unknown,
  payload: unknown,
];

export class OpenSeaJoinReadiness {
  readonly #pendingTopics: Set<string>;
  readonly #promise: Promise<void>;
  readonly #timeout: ReturnType<typeof setTimeout>;
  #resolve!: () => void;
  #reject!: (reason?: unknown) => void;
  #settled = false;

  constructor(collectionSlugs: string[], timeoutMs: number) {
    this.#pendingTopics = new Set(
      collectionSlugs.map((slug) => `collection:${slug}`),
    );
    this.#promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#timeout = setTimeout(() => {
      this.reject(new Error("OpenSea stream subscription timed out"));
    }, timeoutMs);
  }

  observe(data: RawData): void {
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
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timeout);
    this.#resolve();
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

  async backfill(sink: MarketEventSink, signal?: AbortSignal): Promise<void> {
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
    try {
      lock = await acquireBackfillLock(lockPath);
      const checkpoints = await readBackfillCheckpoints(
        checkpointPath,
        collectionsHash,
        this.#config.collectionSlugs.length,
      );
      const latest = checkpoints.at(-1);
      if (latest) await access(spoolPath);
      spool = await open(spoolPath, "a+", 0o600);
      checkpointLog = await open(checkpointPath, "a+", 0o600);

      let collectionIndex = latest?.collectionIndex ?? 0;
      let cursor = latest?.nextCursor;
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
            ? body.asset_events
            : [];
          for (const event of events) {
            await spool.write(
              `${JSON.stringify(normalizeOpenSeaEvent(event))}\n`,
            );
          }
          await spool.sync();

          const nextCursor = text(body.next);
          if (nextCursor && observedCursors.has(nextCursor)) {
            throw new Error("OpenSea backfill cursor did not advance");
          }
          if (nextCursor) observedCursors.add(nextCursor);
          const nextCheckpoint: BackfillCheckpoint = {
            schemaVersion: "1",
            collectionsHash,
            collectionIndex: nextCursor ? collectionIndex : collectionIndex + 1,
            ...(nextCursor ? { nextCursor } : {}),
          };
          await checkpointLog.write(`${JSON.stringify(nextCheckpoint)}\n`);
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
    } finally {
      await spool?.close();
      await checkpointLog?.close();
      if (lock) {
        await releaseBackfillLock(lockPath, lock);
      }
      if (completed || transientParent) {
        await rm(spoolDirectory, { force: true, recursive: true });
      }
      if (transientParent) {
        await rm(transientParent, { force: true, recursive: true });
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

  async start(sink: MarketEventSink): Promise<() => void> {
    const storagePath =
      process.env.OPENSEA_STREAM_STORAGE_PATH ?? ".opensea-stream";
    const readiness = new OpenSeaJoinReadiness(
      this.#config.collectionSlugs,
      this.#streamJoinTimeoutMs,
    );
    class AcknowledgedOpenSeaWebSocket extends WebSocket {
      constructor(address: string | URL, protocols?: string | string[]) {
        super(address, protocols);
        this.on("message", (data) => readiness.observe(data));
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
): Promise<BackfillCheckpoint[]> {
  let contents: string;
  try {
    contents = await readFile(checkpointPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  if (contents !== "" && !contents.endsWith("\n")) {
    throw new Error("OpenSea backfill checkpoint is truncated");
  }
  const checkpoints: BackfillCheckpoint[] = [];
  for (const line of contents.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("OpenSea backfill checkpoint is invalid");
    }
    const value = record(parsed);
    const nextCursor = text(value.nextCursor);
    if (
      value.schemaVersion !== "1" ||
      value.collectionsHash !== collectionsHash ||
      !Number.isSafeInteger(value.collectionIndex) ||
      (value.collectionIndex as number) < 0 ||
      (value.collectionIndex as number) > collectionCount ||
      (value.nextCursor !== undefined && nextCursor === undefined) ||
      ((value.collectionIndex as number) === collectionCount && nextCursor)
    ) {
      throw new Error("OpenSea backfill checkpoint is invalid");
    }
    const checkpoint: BackfillCheckpoint = {
      schemaVersion: "1",
      collectionsHash,
      collectionIndex: value.collectionIndex as number,
      ...(nextCursor ? { nextCursor } : {}),
    };
    const previous = checkpoints.at(-1);
    if (
      previous &&
      checkpoint.collectionIndex !== previous.collectionIndex &&
      checkpoint.collectionIndex !== previous.collectionIndex + 1
    ) {
      throw new Error("OpenSea backfill checkpoint sequence is invalid");
    }
    checkpoints.push(checkpoint);
  }
  return checkpoints;
}

function isMissingFile(error: unknown): boolean {
  return record(error).code === "ENOENT";
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
    try {
      await access(reclaimPath);
      throw fileExistsError(lockPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
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
      if (!(await removeStaleBackfillLock(lockPath))) throw error;
    } finally {
      await candidate?.close();
      await unlink(candidatePath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    }
  }
}

async function removeStaleBackfillLock(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  let observedOwnerText: string;
  try {
    observedOwnerText = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return true;
    throw error;
  }

  const observedOwner = parseBackfillLockOwner(observedOwnerText);
  if (!observedOwner || (await backfillLockOwnerIsLive(observedOwner))) {
    return false;
  }

  try {
    await link(lockPath, reclaimPath);
  } catch (error) {
    if (isMissingFile(error)) return true;
    if (record(error).code === "EEXIST") return false;
    throw error;
  }

  try {
    const reclaimedOwnerText = await readFile(reclaimPath, "utf8");
    const reclaimedOwner = parseBackfillLockOwner(reclaimedOwnerText);
    if (!reclaimedOwner || (await backfillLockOwnerIsLive(reclaimedOwner))) {
      return false;
    }
    const [current, reclaimed] = await Promise.all([
      stat(lockPath),
      stat(reclaimPath),
    ]);
    if (current.dev !== reclaimed.dev || current.ino !== reclaimed.ino) {
      return true;
    }
    await unlink(lockPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  } finally {
    await unlink(reclaimPath).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
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

export async function startOpenSeaMirror(
  adapter: MarketplaceAdapter,
  sink: MarketEventSink,
): Promise<() => void> {
  const stop = await adapter.start(sink);
  try {
    await adapter.backfill(sink);
    return stop;
  } catch (error) {
    stop();
    throw error;
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
