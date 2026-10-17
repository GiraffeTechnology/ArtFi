export type MarketAsset = Readonly<{
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionSlug?: string;
  latestEventType: string;
  latestEventTimestamp: string;
  orderHash?: string;
  orderStatus?: string;
  price?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
}>;

type CatalogFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;
const pageSize = 100;
const maximumPages = 100;
const failure = () =>
  new Error(
    "The market catalog could not be read completely. No partial scan is shown as the full inventory.",
  );
function check(value: unknown): asserts value {
  if (!value) throw failure();
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  check(typeof value === "string" && value.length > 0 && value.length <= 2048);
  return value;
}
function asset(value: unknown): MarketAsset {
  const row = record(value);
  check(row.source === "opensea");
  const chain = text(row.chain);
  check(/^[a-z][a-z0-9-]{1,31}$/.test(chain));
  const contractAddress = text(row.contractAddress);
  check(/^0x[0-9a-fA-F]{40}$/.test(contractAddress));
  const tokenId = text(row.tokenId);
  check(/^(0|[1-9][0-9]{0,77})$/.test(tokenId) && BigInt(tokenId) < 1n << 256n);
  const latestEventType = text(row.latestEventType);
  const latestEventTimestamp = text(row.latestEventTimestamp);
  check(Number.isFinite(Date.parse(latestEventTimestamp)));
  const optional: Partial<
    Record<
      | "collectionSlug"
      | "orderHash"
      | "orderStatus"
      | "price"
      | "paymentSymbol"
      | "marketplaceUrl",
      string
    >
  > = {};
  for (const name of [
    "collectionSlug",
    "orderHash",
    "orderStatus",
    "price",
    "paymentSymbol",
    "marketplaceUrl",
  ] as const) {
    if (row[name] !== undefined) optional[name] = text(row[name]);
  }
  return Object.freeze({
    source: "opensea",
    chain,
    contractAddress,
    tokenId,
    latestEventType,
    latestEventTimestamp,
    ...optional,
  });
}

/** Validates the existing /v1/market/assets page envelope and completes the
 * existing bounded scan before publishing any rows. This is an observation
 * scan, not an atomic chain/database snapshot or authority to trade. */
export async function readCompleteMarketCatalog(
  fetchPage: CatalogFetch,
  apiURL: string,
  signal: AbortSignal,
): Promise<readonly MarketAsset[]> {
  const collected: MarketAsset[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= maximumPages; page += 1) {
    signal.throwIfAborted();
    const response = await fetchPage(
      `${apiURL}/v1/market/assets?source=opensea&page=${page}&pageSize=${pageSize}`,
      {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
      },
    );
    signal.throwIfAborted();
    if (!response.ok)
      throw new Error(
        `The market catalog request failed with status ${response.status}.`,
      );
    const body = record(await response.json());
    signal.throwIfAborted();
    check(
      body.runtime === true &&
        body.schemaVersion === "1" &&
        body.source === "opensea",
    );
    check(
      body.page === page &&
        body.pageSize === pageSize &&
        Array.isArray(body.data),
    );
    check(
      typeof body.total === "number" &&
        Number.isSafeInteger(body.total) &&
        body.total >= 0,
    );
    if (body.total > maximumPages * pageSize) {
      throw new Error(
        "This catalog exceeds the complete-scan limit. Narrow server-side catalog access is required; no truncated inventory is shown.",
      );
    }
    expectedTotal ??= body.total;
    check(
      body.total === expectedTotal &&
        body.data.length ===
          Math.min(pageSize, expectedTotal - collected.length),
    );
    for (const value of body.data) {
      const item = asset(value);
      const identity = JSON.stringify([
        item.source,
        item.chain,
        item.contractAddress.toLowerCase(),
        item.tokenId,
      ]);
      check(!seen.has(identity));
      seen.add(identity);
      collected.push(item);
    }
    if (collected.length === expectedTotal) return Object.freeze(collected);
  }
  throw failure();
}
