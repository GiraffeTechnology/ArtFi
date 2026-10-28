import { isAddress } from "viem";
import {
  administrationText,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "./administration-transport";
import { parsePortfolioHistoryEntry } from "./portfolio-records-contract";
import type { PortfolioEntry } from "./portfolio-records-state";

export type IndexedHistoryFilter = {
  status: "all" | "pending" | "confirmed" | "removed";
  eventName: string;
  contractAddress: string;
  order: "newest" | "oldest";
  page: number;
};
export type IndexedHistoryPage = {
  address: string;
  chainId: 560048;
  scope: "indexed_chain_events";
  filters: IndexedHistoryFilter;
  pageSize: 10;
  total: number;
  data: readonly PortfolioEntry[];
};
export const initialIndexedHistoryFilter: Readonly<IndexedHistoryFilter> =
  Object.freeze({
    status: "all",
    eventName: "",
    contractAddress: "",
    order: "newest",
    page: 1,
  });
export const indexedHistoryPageLimit = 1_000_000;
export const indexedHistoryByteLimit = 64 * 1024;
function invalid(): never {
  throw new Error("Indexed transaction history is unavailable.");
}
export function snapshotIndexedHistoryFilter(
  filter: IndexedHistoryFilter,
): IndexedHistoryFilter {
  if (
    !filter ||
    !["all", "pending", "confirmed", "removed"].includes(filter.status) ||
    !["newest", "oldest"].includes(filter.order) ||
    typeof filter.eventName !== "string" ||
    (filter.eventName !== "" &&
      !/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(filter.eventName)) ||
    typeof filter.contractAddress !== "string" ||
    (filter.contractAddress !== "" && !isAddress(filter.contractAddress)) ||
    !Number.isSafeInteger(filter.page) ||
    filter.page < 1 ||
    filter.page > indexedHistoryPageLimit
  )
    invalid();
  return Object.freeze({
    status: filter.status,
    eventName: filter.eventName,
    contractAddress: filter.contractAddress.toLowerCase(),
    order: filter.order,
    page: filter.page,
  });
}
export function readIndexedHistoryFilter(query: URLSearchParams) {
  for (const key of query.keys())
    if (
      !["status", "eventName", "contractAddress", "order", "page"].includes(
        key,
      ) ||
      query.getAll(key).length !== 1 ||
      !query.get(key)
    )
      invalid();
  const page = query.get("page") ?? "1";
  if (!/^[1-9][0-9]{0,6}$/.test(page)) invalid();
  return snapshotIndexedHistoryFilter({
    status: (query.get("status") ?? "all") as IndexedHistoryFilter["status"],
    eventName: query.get("eventName") ?? "",
    contractAddress: query.get("contractAddress") ?? "",
    order: (query.get("order") ?? "newest") as IndexedHistoryFilter["order"],
    page: Number(page),
  });
}
export function indexedHistoryQuery(raw: IndexedHistoryFilter) {
  const filter = snapshotIndexedHistoryFilter(raw);
  const query = new URLSearchParams({
    status: filter.status,
    order: filter.order,
    page: String(filter.page),
  });
  if (filter.eventName) query.set("eventName", filter.eventName);
  if (filter.contractAddress)
    query.set("contractAddress", filter.contractAddress);
  return query;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
export function readIndexedHistoryPage(
  value: unknown,
  address: string,
  rawFilter: IndexedHistoryFilter,
): IndexedHistoryPage {
  const filter = snapshotIndexedHistoryFilter(rawFilter);
  if (!isAddress(address)) invalid();
  const row = record(value);
  exactKeys(row, [
    "address",
    "chainId",
    "scope",
    "filters",
    "pageSize",
    "total",
    "data",
  ]);
  const echo = record(row.filters);
  exactKeys(echo, ["status", "eventName", "contractAddress", "order", "page"]);
  if (
    row.address !== address.toLowerCase() ||
    row.chainId !== 560048 ||
    row.scope !== "indexed_chain_events" ||
    row.pageSize !== 10 ||
    typeof row.total !== "number" ||
    !Number.isSafeInteger(row.total) ||
    row.total < 0 ||
    Object.keys(filter).some(
      (key) => echo[key] !== filter[key as keyof IndexedHistoryFilter],
    ) ||
    !Array.isArray(row.data) ||
    row.data.length !==
      Math.min(10, Math.max(0, row.total - (filter.page - 1) * 10))
  )
    invalid();
  const data = row.data.map((value: unknown) =>
    Object.freeze(parsePortfolioHistoryEntry(value)),
  );
  const ids = new Set<string>();
  let previous: PortfolioEntry | undefined;
  for (const entry of data) {
    if (
      ids.has(entry.id) ||
      (filter.status !== "all" && entry.status !== filter.status) ||
      (filter.eventName !== "" && entry.eventName !== filter.eventName) ||
      (filter.contractAddress !== "" &&
        entry.contractAddress.toLowerCase() !== filter.contractAddress)
    )
      invalid();
    ids.add(entry.id);
    if (previous) {
      const order =
        previous.blockNumber - entry.blockNumber ||
        previous.logIndex - entry.logIndex ||
        (previous.transactionHash.toLowerCase() <
        entry.transactionHash.toLowerCase()
          ? -1
          : previous.transactionHash.toLowerCase() >
              entry.transactionHash.toLowerCase()
            ? 1
            : 0);
      if (filter.order === "oldest" ? order >= 0 : order <= 0) invalid();
    }
    previous = entry;
  }
  return Object.freeze({
    address: address.toLowerCase(),
    chainId: 560048,
    scope: "indexed_chain_events",
    filters: filter,
    pageSize: 10,
    total: row.total,
    data: Object.freeze(data),
  });
}
export async function requestIndexedHistory(
  address: string,
  rawFilter: IndexedHistoryFilter,
  parent: AbortSignal,
): Promise<IndexedHistoryPage> {
  const filter = snapshotIndexedHistoryFilter(rawFilter);
  if (!isAddress(address)) invalid();
  return withAdministrationDeadline(async (signal) => {
    const response = await fetch(
      `/api/portfolio/${address.toLowerCase()}/history?${indexedHistoryQuery(filter)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      },
    );
    if (signal.aborted) {
      discardAdministrationBody(response);
      signal.throwIfAborted();
    }
    try {
      if (
        !response.ok ||
        response.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        invalid();
      return readIndexedHistoryPage(
        JSON.parse(
          await administrationText(response, indexedHistoryByteLimit, signal),
        ),
        address,
        filter,
      );
    } finally {
      if (!response.bodyUsed) discardAdministrationBody(response);
    }
  }, parent);
}

export type IndexedHistoryState = Readonly<{
  filter: IndexedHistoryFilter;
  status: "loading" | "ready" | "error" | "disposed";
  page?: IndexedHistoryPage;
}>;
/** One immutable wallet/session component owns this controller. Late reads cannot
 * publish after a filter change, refresh, unmount, logout or account replacement. */
export function createIndexedHistoryController(
  address: string,
  request: typeof requestIndexedHistory = requestIndexedHistory,
) {
  let state: IndexedHistoryState = Object.freeze({
    filter: snapshotIndexedHistoryFilter(initialIndexedHistoryFilter),
    status: "loading",
  });
  let active: AbortController | undefined;
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(next: IndexedHistoryState) {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  async function load(raw = state.filter) {
    if (disposed) return;
    const filter = snapshotIndexedHistoryFilter(raw);
    const current = ++generation;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    publish({ filter, status: "loading" });
    try {
      const page = await request(address, filter, controller.signal);
      if (!disposed && !controller.signal.aborted && generation === current)
        publish({ filter, status: "ready", page });
    } catch {
      if (!disposed && !controller.signal.aborted && generation === current)
        publish({ filter, status: "error" });
    } finally {
      if (active === controller) active = undefined;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      disposed = false;
    },
    refresh: () => load(),
    change: (next: IndexedHistoryFilter) => load(next),
    dispose() {
      disposed = true;
      generation++;
      active?.abort();
      active = undefined;
      publish({ filter: state.filter, status: "disposed" });
      listeners.clear();
    },
  };
}
