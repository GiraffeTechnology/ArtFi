import type {
  Portfolio,
  PortfolioEntry,
  PortfolioPerformance,
} from "./portfolio-records-state";

export class PortfolioRecordsError extends Error {
  constructor(reason: "context" | "contract" | "http", status?: number) {
    super(
      reason === "context"
        ? "Portfolio response did not match the connected Hoodi address."
        : reason === "http" &&
            Number.isInteger(status) &&
            status! >= 100 &&
            status! <= 599
          ? `Portfolio API returned ${status}.`
          : "Portfolio records are unavailable: the API response was incomplete.",
    );
  }
}
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
function refuse(): never {
  throw new PortfolioRecordsError("contract");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return refuse();
  return value;
}
function address(value: unknown): string {
  if (typeof value !== "string" || !addressPattern.test(value)) return refuse();
  return value;
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    return refuse();
  return value as number;
}
function integer(value: unknown, signed = false): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value)
  )
    return refuse();
  return value;
}
function nullableInteger(value: unknown, signed = false): string | null {
  return value === null ? null : integer(value, signed);
}
function observedAt(value: unknown): string {
  const result = text(value, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 19) !== result.slice(0, 19)
  )
    return refuse();
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return refuse();
  return value;
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) return refuse();
    seen.add(id);
  }
  return items;
}
function reasons(value: unknown): string[] {
  return list(value).map((v) => text(v, 1024));
}
function entry(value: unknown): PortfolioEntry {
  const input = record(value),
    transactionHash = text(input.transactionHash, 66);
  if (!hashPattern.test(transactionHash)) return refuse();
  const logIndex = count(input.logIndex, 4294967295);
  const id = text(input.id, 256);
  if (id !== `560048:${transactionHash.toLowerCase()}:${logIndex}`)
    return refuse();
  const eventName = text(input.eventName, 80);
  if (
    !/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(eventName) ||
    !["pending", "confirmed", "removed"].includes(input.status as string)
  )
    return refuse();
  return {
    id,
    transactionHash,
    logIndex,
    contractAddress: address(input.contractAddress),
    eventName,
    blockNumber: count(input.blockNumber),
    status: input.status as PortfolioEntry["status"],
    observedAt: observedAt(input.observedAt),
  };
}
function notificationMessage(item: PortfolioEntry): string {
  return item.status === "removed"
    ? `${item.eventName} was removed from the canonical chain. Any previous confirmation no longer applies.`
    : item.status === "confirmed"
      ? `${item.eventName} is confirmed in the indexed chain history.`
      : `${item.eventName} was observed for this wallet. Confirmation is pending.`;
}
function performance(value: unknown): PortfolioPerformance {
  const input = record(value);
  if (
    input.method !== "fifo" ||
    input.scope !== "confirmed_indexed_fraction_trades" ||
    !["unknown", "known_for_indexed_history", "no_indexed_history"].includes(
      input.status as string,
    )
  )
    return refuse();
  const items = unique(
    list(input.items).map((value) => {
      const row = record(value);
      if (row.status !== "known" && row.status !== "unknown") return refuse();
      const item = {
        assetToken: address(row.assetToken),
        paymentToken:
          row.paymentToken === null ? null : address(row.paymentToken),
        confirmedQuantity: nullableInteger(row.confirmedQuantity, true),
        costBasis: nullableInteger(row.costBasis),
        realizedPnl: nullableInteger(row.realizedPnl, true),
        status: row.status as "known" | "unknown",
        buyCount: count(row.buyCount),
        sellCount: count(row.sellCount),
        reasons: reasons(row.reasons),
      };
      if (
        item.status === "known" &&
        [
          item.paymentToken,
          item.confirmedQuantity,
          item.costBasis,
          item.realizedPnl,
        ].some((v) => v === null)
      )
        return refuse();
      return item;
    }),
    (item) => item.assetToken.toLowerCase(),
  );
  return {
    status: input.status as PortfolioPerformance["status"],
    method: "fifo",
    scope: "confirmed_indexed_fraction_trades",
    items,
    unmappedTradeCount: count(input.unmappedTradeCount),
    pendingEventCount: count(input.pendingEventCount),
    reasons: reasons(input.reasons),
  };
}

/** Decode only the actual indexed response contract. This proves neither chain balance nor rights authority. */
export function parsePortfolioRecords(
  value: unknown,
  expectedAddress: string,
): Portfolio {
  const input = record(value);
  if (
    !addressPattern.test(expectedAddress) ||
    typeof input.address !== "string" ||
    input.address.toLowerCase() !== expectedAddress.toLowerCase() ||
    input.chainId !== 560048 ||
    input.network !== "hoodi"
  )
    throw new PortfolioRecordsError("context");
  const positions = unique(
    list(input.positions).map((value) => {
      const row = record(value);
      return {
        assetToken: address(row.assetToken),
        symbol: text(row.symbol, 128),
        balance: integer(row.balance, true),
        updatedAt: observedAt(row.updatedAt),
      };
    }),
    (row) => row.assetToken.toLowerCase(),
  );
  const transactions = unique(
    list(input.transactions).map(entry),
    (row) => row.id,
  );
  const transactionByID = new Map(transactions.map((row) => [row.id, row]));
  const notifications = unique(
    list(input.notifications).map((value) => {
      const row = entry(value),
        source = record(value),
        message = text(source.message, 1024);
      if (message !== notificationMessage(row)) return refuse();
      const prior = transactionByID.get(row.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row))
        return refuse();
      return { ...row, message };
    }),
    (row) => row.id,
  );
  return {
    address: address(input.address),
    chainId: 560048,
    network: "hoodi",
    positions,
    transactions,
    offers: [...list(input.offers)],
    notifications,
    ...(input.performance === undefined
      ? {}
      : { performance: performance(input.performance) }),
  };
}

/** The paged history endpoint uses the same canonical indexed-event decoder. */
export function parsePortfolioHistoryEntry(value: unknown): PortfolioEntry {
  return entry(value);
}
