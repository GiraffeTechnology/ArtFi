import type { NftOperationHistory, NftOperationSummary } from "./model";

export const nftHistoryActions = [
  "list",
  "offer",
  "buy",
  "accept",
  "cancel",
] as const;
export const nftHistoryStatuses = [
  "initiated",
  "awaiting-wallet",
  "submitted",
  "accepted",
  "rejected",
  "pending",
  "confirmed",
  "failed",
  "cancelled",
] as const;
const rootKeys = ["data", "page", "pageSize", "hasMore", "wallet", "chainId"];
const rowKeys = [
  "id",
  "chainId",
  "status",
  "action",
  "collection",
  "tokenId",
  "kind",
  "walletStarted",
  "transactionHash",
  "orderHash",
  "updatedAt",
];
function refuse(): never {
  throw new Error(
    "The private NFT history returned an invalid or mismatched page. Sign in and refresh before continuing.",
  );
}
function fields(
  value: unknown,
  allowed: readonly string[],
  required = allowed,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        !allowed.includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value"),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    refuse();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}
function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) refuse();
  return value.toLowerCase();
}
function hash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) refuse();
  return value.toLowerCase();
}
function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) refuse();
  return value;
}
function timestamp(value: unknown): string {
  const raw = string(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
  );
  const time = Date.parse(raw);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)
  )
    refuse();
  return raw;
}
function timeKey(value: string): string {
  return (
    value.slice(0, 19) +
    "." +
    (value.split(".")[1]?.slice(0, -1) ?? "").padEnd(9, "0")
  );
}
/** Display admission only; summary data never authorizes recovery or another wallet action. */
export function readNftHistoryPage(
  raw: unknown,
  expected: { wallet: string; chainId: number; page: number },
): NftOperationHistory {
  const body = fields(raw, rootKeys);
  const wallet = address(body.wallet),
    expectedWallet = address(expected.wallet);
  if (
    ![1, 8453].includes(expected.chainId) ||
    !Number.isSafeInteger(expected.page) ||
    expected.page < 1 ||
    expected.page > 999999 ||
    wallet !== expectedWallet ||
    body.chainId !== expected.chainId ||
    body.page !== expected.page ||
    body.pageSize !== 25 ||
    typeof body.hasMore !== "boolean" ||
    !Array.isArray(body.data) ||
    body.data.length > 25
  )
    refuse();
  const array = Object.getOwnPropertyDescriptors(body.data);
  if (Reflect.ownKeys(array).length !== body.data.length + 1) refuse();
  const ids = new Set<string>();
  let previousTime: string | undefined;
  const data = Array.from(
    { length: body.data.length },
    (_, index): NftOperationSummary => {
      const descriptor = array[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) refuse();
      const row = fields(
        descriptor.value,
        rowKeys,
        rowKeys.filter(
          (key) => !["transactionHash", "orderHash"].includes(key),
        ),
      );
      const id = string(row.id, /^[a-zA-Z0-9_-]{16,80}$/);
      if (
        ids.has(id) ||
        row.chainId !== expected.chainId ||
        !nftHistoryActions.includes(
          row.action as (typeof nftHistoryActions)[number],
        ) ||
        !nftHistoryStatuses.includes(
          row.status as (typeof nftHistoryStatuses)[number],
        ) ||
        typeof row.kind !== "string" ||
        !["approval", "signature", "transaction"].includes(row.kind) ||
        typeof row.walletStarted !== "boolean"
      )
        refuse();
      ids.add(id);
      const tokenId = string(row.tokenId, /^(0|[1-9][0-9]{0,77})$/);
      if (BigInt(tokenId) >= 1n << 256n) refuse();
      const updatedAt = timestamp(row.updatedAt),
        key = timeKey(updatedAt);
      if (previousTime !== undefined && key > previousTime) refuse();
      previousTime = key;
      const result: NftOperationSummary = {
        id,
        chainId: expected.chainId,
        action: row.action as string,
        status: row.status as string,
        collection: string(row.collection, /^[a-z0-9][a-z0-9-]{0,99}$/),
        tokenId,
        kind: row.kind as string,
        walletStarted: row.walletStarted as boolean,
        updatedAt,
      };
      const transactionHash = hash(row.transactionHash),
        orderHash = hash(row.orderHash);
      if (transactionHash) result.transactionHash = transactionHash;
      if (orderHash) result.orderHash = orderHash;
      return result;
    },
  );
  return {
    wallet,
    chainId: expected.chainId,
    page: expected.page,
    pageSize: 25,
    hasMore: body.hasMore,
    data,
  };
}
export type NftHistoryFilter = {
  action: string;
  status: string;
  query: string;
};
export function filterNftHistoryPage(
  history: NftOperationHistory,
  filter: NftHistoryFilter,
): NftOperationSummary[] {
  if (
    (filter.action !== "all" &&
      !nftHistoryActions.includes(
        filter.action as (typeof nftHistoryActions)[number],
      )) ||
    (filter.status !== "all" &&
      !nftHistoryStatuses.includes(
        filter.status as (typeof nftHistoryStatuses)[number],
      )) ||
    filter.query.length > 200
  )
    refuse();
  const query = filter.query.trim().toLowerCase();
  return history.data.filter(
    (row) =>
      (filter.action === "all" || row.action === filter.action) &&
      (filter.status === "all" || row.status === filter.status) &&
      (!query ||
        [
          row.id,
          row.collection,
          row.tokenId,
          row.transactionHash,
          row.orderHash,
        ].some((value) => value?.toLowerCase().includes(query))),
  );
}
export function nftHistoryMeaning(row: NftOperationSummary): string {
  switch (row.status) {
    case "initiated":
      return "An operation was recorded; no wallet or venue result is established.";
    case "awaiting-wallet":
      return row.walletStarted
        ? "A wallet attempt was recorded. Recover its outcome before another attempt."
        : "An unsigned review awaits wallet confirmation.";
    case "submitted":
      return "A submission was recorded. Submission is not confirmation.";
    case "accepted":
      return "The venue accepted an order. This does not establish settlement or current order availability.";
    case "pending":
      return "The result is pending or uncertain. Recover and reconcile it before another wallet action.";
    case "confirmed":
      return row.kind === "approval"
        ? "An approval was recorded as confirmed. It does not publish or settle an NFT order."
        : "The record is marked confirmed. This history is not a fresh venue or chain observation.";
    case "rejected":
      return "The action was recorded as rejected. Recover it to inspect the original result.";
    case "failed":
      return "The action was recorded as failed. This record does not authorize a resend.";
    case "cancelled":
      return "The record is cancelled. Recover it to distinguish a discarded review from an order cancellation.";
    default:
      return "The recorded result is unavailable.";
  }
}
