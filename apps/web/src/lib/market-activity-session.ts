import type { MarketActivityEvent } from "./market-activity";

const pageSize = 25;
const responseByteLimit = 2 * 1024 * 1024;
export class MarketHistoryError extends Error {}
export type MarketHistorySnapshot = Readonly<{
  contract: string;
  events: readonly Readonly<MarketActivityEvent>[];
  cursor?: string;
  finished: boolean;
  loading: boolean;
  started: boolean;
  error?: string;
}>;
type Page = { events: Readonly<MarketActivityEvent>[]; cursor?: string };
export function normalizeHistoryContract(value: string): string {
  const contract = value.trim().toLowerCase();
  if (contract && !/^0x[0-9a-f]{40}$/.test(contract))
    throw new MarketHistoryError(
      "Enter a complete 20-byte contract address, or leave it empty for all contracts.",
    );
  return contract;
}
export function marketHistoryQuery(contract: string, cursor?: string): string {
  const query = new URLSearchParams({
    source: "opensea",
    limit: String(pageSize),
  });
  const normalized = normalizeHistoryContract(contract);
  if (normalized) query.set("contract", normalized);
  if (cursor !== undefined) query.set("cursor", cursor);
  return query.toString();
}
function invalid(): never {
  throw new MarketHistoryError(
    "The mirror returned invalid or mismatched activity data. No page was appended.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
  return value;
}
function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined || value === "" ? undefined : text(value, max);
}
function quantity(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  )
    invalid();
  return value;
}
function address(value: unknown): string | undefined {
  const result = optionalText(value, 42);
  if (result && !/^0x[0-9a-fA-F]{40}$/.test(result)) invalid();
  return result?.toLowerCase();
}
function hash(value: unknown): string | undefined {
  const result = optionalText(value, 66);
  if (result && !/^0x[0-9a-fA-F]{64}$/.test(result)) invalid();
  return result?.toLowerCase();
}
/** Parse only displayed attribution fields; raw provider payload is not copied into UI state. */
export function parseMarketHistoryPage(raw: unknown, contract: string): Page {
  const page = object(raw);
  if (
    page.schemaVersion !== "1" ||
    page.source !== "opensea" ||
    page.custody !== false ||
    !Array.isArray(page.data) ||
    page.data.length > pageSize
  )
    invalid();
  let cursor: string | undefined;
  if (Object.hasOwn(page, "nextCursor")) {
    cursor = text(page.nextCursor, 4096);
    if (cursor !== cursor.trim()) invalid();
  }
  let previous = Infinity;
  const events = page.data.map((value) => {
    const event = object(value);
    const eventId = text(event.eventId, 64);
    if (!/^[0-9a-f]{64}$/.test(eventId) || event.source !== "opensea")
      invalid();
    const eventType = text(event.eventType, 80),
      eventFamily = text(event.eventFamily, 32),
      chain = text(event.chain, 32);
    if (
      !["order", "sale", "transfer", "metadata"].includes(eventFamily) ||
      !/^[a-z][a-z0-9-]{1,31}$/.test(chain)
    )
      invalid();
    const eventTimestamp = text(event.eventTimestamp, 40),
      time = Date.parse(eventTimestamp);
    if (!Number.isFinite(time) || time > previous) invalid();
    previous = time;
    const contractAddress = address(event.contractAddress);
    if (contract && contractAddress !== contract) invalid();
    return Object.freeze({
      eventId,
      source: "opensea",
      eventType,
      eventFamily,
      chain,
      eventTimestamp,
      contractAddress,
      tokenId: quantity(event.tokenId),
      collectionSlug: optionalText(event.collectionSlug, 160),
      orderHash: hash(event.orderHash),
      price: quantity(event.price),
      paymentSymbol: optionalText(event.paymentSymbol, 16),
      marketplaceUrl: optionalText(event.marketplaceUrl, 4096),
    });
  });
  return { events, cursor };
}
async function readMarketHistoryBody(
  apiURL: string,
  query: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${apiURL}/v1/market/activity?${query}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new MarketHistoryError(
      response.status === 503
        ? "The external-market mirror is unavailable, so no history can be shown. This is not the same as no activity."
        : `The external-market mirror answered HTTP ${response.status}.`,
    );
  if (
    response.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    !response.body
  )
    throw new MarketHistoryError(
      "The mirror did not return a readable JSON activity page.",
    );
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseByteLimit)
        throw new MarketHistoryError(
          "The activity page exceeded the read limit. No history page was appended.",
        );
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof MarketHistoryError || signal.aborted) throw error;
    throw new MarketHistoryError(
      "The mirror returned unreadable activity JSON. No history page was appended.",
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* The request may already be aborted. */
    }
    reader.releaseLock();
  }
}
/** Bound both response headers and body reads; an unavailable page stays distinct from empty data. */
export async function readMarketHistoryPage(
  apiURL: string,
  query: string,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    return await readMarketHistoryBody(apiURL, query, controller.signal);
  } catch (error) {
    if (timedOut)
      throw new MarketHistoryError(
        "The activity read timed out. The history is incomplete; retry or refresh it.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
export function createMarketHistorySession(
  readPage: (query: string, signal: AbortSignal) => Promise<unknown>,
) {
  const empty = (contract: string): MarketHistorySnapshot =>
    Object.freeze({
      contract,
      events: Object.freeze([]),
      finished: false,
      loading: false,
      started: false,
    });
  let state = empty(""),
    active = false,
    generation = 0,
    request: AbortController | undefined;
  let seenCursors = new Set<string>();
  const listeners = new Set<() => void>();
  const server = state;
  const publish = (next: MarketHistorySnapshot) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const isCurrent = (epoch: number, controller: AbortController) =>
    active &&
    generation === epoch &&
    request === controller &&
    !controller.signal.aborted;
  function cancel() {
    generation++;
    const previous = request;
    request = undefined;
    previous?.abort();
  }
  async function loadMore() {
    if (!active || state.loading || state.finished) return;
    const epoch = generation,
      controller = new AbortController(),
      before = state;
    request = controller;
    publish({ ...before, loading: true, error: undefined });
    try {
      const raw = await readPage(
        marketHistoryQuery(before.contract, before.cursor),
        controller.signal,
      );
      if (!isCurrent(epoch, controller)) return;
      const page = parseMarketHistoryPage(raw, before.contract);
      if (
        page.cursor &&
        (page.cursor === before.cursor || seenCursors.has(page.cursor))
      )
        throw new MarketHistoryError(
          "The mirror repeated an activity cursor. The history is incomplete; refresh it before continuing.",
        );
      const events = [...before.events],
        byId = new Map(events.map((event) => [event.eventId, event]));
      let lastTime = events.length
        ? Date.parse(events[events.length - 1]!.eventTimestamp)
        : Infinity;
      for (const event of page.events) {
        const old = byId.get(event.eventId);
        if (old) {
          if (JSON.stringify(old) !== JSON.stringify(event))
            throw new MarketHistoryError(
              "The mirror changed an existing event identity. Refresh the history before continuing.",
            );
          continue;
        }
        const time = Date.parse(event.eventTimestamp);
        if (time > lastTime) invalid();
        lastTime = time;
        events.push(event);
        byId.set(event.eventId, event);
      }
      if (page.cursor) seenCursors.add(page.cursor);
      publish({
        ...before,
        events: Object.freeze(events),
        cursor: page.cursor,
        finished: page.cursor === undefined,
        loading: false,
        started: true,
      });
    } catch (error) {
      if (!isCurrent(epoch, controller)) return;
      publish({
        ...before,
        loading: false,
        started: true,
        error:
          error instanceof MarketHistoryError
            ? error.message
            : "The mirrored activity could not be read. The history is not known to be empty.",
      });
    } finally {
      if (isCurrent(epoch, controller)) request = undefined;
    }
  }
  function applyFilter(value: string) {
    const contract = normalizeHistoryContract(value);
    cancel();
    seenCursors = new Set();
    publish(empty(contract));
    if (active) void loadMore();
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => server,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate() {
      if (active) return;
      active = true;
      if (!state.started) void loadMore();
    },
    deactivate() {
      active = false;
      cancel();
      if (state.loading) publish({ ...state, loading: false });
    },
    applyFilter,
    loadMore,
    refresh: () => applyFilter(state.contract),
  };
}
