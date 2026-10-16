import type { PortfolioEntry } from "./portfolio-records-state";

export type PortfolioHistoryFilter = {
  status: "all" | PortfolioEntry["status"];
  eventName: string;
  direction: "newest" | "oldest";
  page: number;
};

export const PORTFOLIO_HISTORY_PAGE_SIZE = 10;
export const INITIAL_PORTFOLIO_HISTORY_FILTER: PortfolioHistoryFilter = {
  status: "all", eventName: "", direction: "newest", page: 1,
};

/** Local pages describe only the authenticated response already loaded. */
export function projectPortfolioHistory(entries: readonly PortfolioEntry[], filter: PortfolioHistoryFilter) {
  if (!Array.isArray(entries) || !validFilter(filter)) throw new Error("Indexed history is unavailable.");
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!validEntry(entry) || ids.has(entry.id)) throw new Error("Indexed history is unavailable.");
    ids.add(entry.id);
  }
  const eventNames = [...new Set(entries.map((entry) => entry.eventName))].sort();
  const matching = entries.filter((entry) =>
    (filter.status === "all" || entry.status === filter.status) &&
    (filter.eventName === "" || entry.eventName === filter.eventName),
  );
  matching.sort((left, right) => {
    const order = left.blockNumber - right.blockNumber || left.logIndex - right.logIndex ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return filter.direction === "newest" ? -order : order;
  });
  const pages = Math.max(1, Math.ceil(matching.length / PORTFOLIO_HISTORY_PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const offset = (page - 1) * PORTFOLIO_HISTORY_PAGE_SIZE;
  return {
    totalLoaded: entries.length,
    totalMatching: matching.length,
    eventNames,
    page,
    pages,
    first: matching.length === 0 ? 0 : offset + 1,
    last: Math.min(offset + PORTFOLIO_HISTORY_PAGE_SIZE, matching.length),
    entries: matching.slice(offset, offset + PORTFOLIO_HISTORY_PAGE_SIZE),
  };
}

function validFilter(filter: PortfolioHistoryFilter) {
  return filter !== null && typeof filter === "object" &&
    ["all", "pending", "confirmed", "removed"].includes(filter.status) &&
    typeof filter.eventName === "string" &&
    (filter.eventName === "" || /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(filter.eventName)) &&
    ["newest", "oldest"].includes(filter.direction) && Number.isSafeInteger(filter.page) && filter.page > 0;
}

function validEntry(entry: PortfolioEntry) {
  return entry !== null && typeof entry === "object" &&
    typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 256 &&
    typeof entry.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash) &&
    typeof entry.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(entry.contractAddress) &&
    typeof entry.eventName === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(entry.eventName) &&
    Number.isSafeInteger(entry.blockNumber) && entry.blockNumber >= 0 &&
    Number.isSafeInteger(entry.logIndex) && entry.logIndex >= 0 &&
    ["pending", "confirmed", "removed"].includes(entry.status) &&
    typeof entry.observedAt === "string" && entry.observedAt.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(entry.observedAt) &&
    Number.isFinite(Date.parse(entry.observedAt));
}
