import { readMarketAsset, type MarketAsset } from "./complete-market-catalog";

export type MarketCatalogFilters = Readonly<{
  q: string;
  listingStatus: string;
  sort: string;
}>;
export const emptyMarketCatalogFilters = (): MarketCatalogFilters => ({
  q: "",
  listingStatus: "all",
  sort: "newest",
});
const pageSize = 12;
const maximumPage = 1000000;
function check(value: unknown): asserts value {
  if (!value)
    throw new Error(
      "The catalog page does not match this search. Retry or return to the first page; no stale inventory is substituted.",
    );
}
export function marketCatalogQuery(
  filters: MarketCatalogFilters,
  page: number,
) {
  check(filters && typeof filters.q === "string");
  const q = filters.q.trim();
  check(Array.from(q).length <= 100 && !/\p{Cc}/u.test(q));
  check(["all", "active", "inactive"].includes(filters.listingStatus));
  check(["newest", "oldest", "token"].includes(filters.sort));
  check(Number.isSafeInteger(page) && page >= 1 && page <= maximumPage);
  return new URLSearchParams({
    source: "opensea",
    page: String(page),
    pageSize: String(pageSize),
    q,
    listingStatus: filters.listingStatus,
    sort: filters.sort,
  });
}
export type MarketCatalogPage = Readonly<{
  data: readonly MarketAsset[];
  total: number;
  page: number;
  pageSize: number;
  filters: MarketCatalogFilters;
}>;
export function readMarketCatalogPage(
  value: unknown,
  request: URLSearchParams,
): MarketCatalogPage {
  const expected = marketCatalogQuery(
    {
      q: request.get("q") ?? "",
      listingStatus: request.get("listingStatus") ?? "",
      sort: request.get("sort") ?? "",
    },
    Number(request.get("page")),
  );
  check(
    request.getAll("page").length === 1 &&
      request.toString() === expected.toString(),
  );
  check(value && typeof value === "object" && !Array.isArray(value));
  const body = value as Record<string, unknown>;
  check(
    body.runtime === true &&
      body.schemaVersion === "1" &&
      body.source === "opensea",
  );
  const page = Number(expected.get("page"));
  check(
    body.page === page &&
      body.pageSize === pageSize &&
      body.q === expected.get("q") &&
      body.listingStatus === expected.get("listingStatus") &&
      body.sort === expected.get("sort"),
  );
  check(
    typeof body.total === "number" &&
      Number.isSafeInteger(body.total) &&
      body.total >= 0 &&
      Array.isArray(body.data),
  );
  check(page <= Math.max(1, Math.ceil(body.total / pageSize)));
  check(
    body.data.length ===
      Math.min(pageSize, Math.max(0, body.total - (page - 1) * pageSize)),
  );
  const seen = new Set<string>();
  const data = body.data.map((value) => {
    const row = readMarketAsset(value);
    const key = JSON.stringify([
      row.chain,
      row.contractAddress.toLowerCase(),
      row.tokenId,
    ]);
    check(!seen.has(key));
    seen.add(key);
    return row;
  });
  return Object.freeze({
    data: Object.freeze(data),
    total: body.total,
    page,
    pageSize,
    filters: Object.freeze({
      q: body.q as string,
      listingStatus: body.listingStatus as string,
      sort: body.sort as string,
    }),
  });
}

export async function fetchMarketCatalogPage(
  fetchPage: typeof fetch,
  apiURL: string,
  filters: MarketCatalogFilters,
  page: number,
  signal: AbortSignal,
): Promise<MarketCatalogPage> {
  signal.throwIfAborted();
  const query = marketCatalogQuery(filters, page);
  const response = await fetchPage(`${apiURL}/v1/market/assets?${query}`, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  signal.throwIfAborted();
  if (!response.ok)
    throw new Error(
      `The mirrored catalog request failed with status ${response.status}.`,
    );
  const payload: unknown = await response.json();
  signal.throwIfAborted();
  return readMarketCatalogPage(payload, query);
}
