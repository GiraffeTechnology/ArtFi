import { describe, expect, it, vi } from "vitest";
import {
  emptyMarketCatalogFilters,
  fetchMarketCatalogPage,
  marketCatalogQuery,
  readMarketCatalogPage,
} from "./market-catalog-query";
const row = (id: number) => ({
  source: "opensea",
  chain: "ethereum",
  contractAddress: "0x" + "a".repeat(40),
  tokenId: String(id),
  latestEventType: "item_listed",
  latestEventTimestamp: "2026-10-17T12:00:00Z",
  price: "9007199254740993123456789",
});
const request = (page = 1) =>
  marketCatalogQuery(
    { q: "Ink%_!", listingStatus: "active", sort: "token" },
    page,
  );
const payload = (page = 1, total = 13) => ({
  runtime: true,
  schemaVersion: "1",
  source: "opensea",
  page,
  pageSize: 12,
  q: "Ink%_!",
  listingStatus: "active",
  sort: "token",
  total,
  data: Array.from(
    { length: Math.min(12, Math.max(0, total - (page - 1) * 12)) },
    (_, i) => row((page - 1) * 12 + i),
  ),
});
describe("server-side mirror catalog contract", () => {
  it("builds bounded literal search/filter/order query without interpreting search as URL fields", () => {
    const params = marketCatalogQuery(
      {
        q: "  Ink&sort=oldest %_!  ",
        listingStatus: "inactive",
        sort: "token",
      },
      2,
    );
    expect(params.get("q")).toBe("Ink&sort=oldest %_!");
    expect(params.getAll("sort")).toEqual(["token"]);
    expect(params.get("listingStatus")).toBe("inactive");
    expect(params.get("page")).toBe("2");
  });
  it.each([
    { q: "x".repeat(101) },
    { q: "a\u0000b" },
    { listingStatus: "ACTIVE" },
    { sort: "DROP" },
  ])("rejects invalid request %o", (patch) => {
    expect(() =>
      marketCatalogQuery({ ...emptyMarketCatalogFilters(), ...patch }, 1),
    ).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1000001])(
    "rejects invalid page %s",
    (page) => {
      expect(() =>
        marketCatalogQuery(emptyMarketCatalogFilters(), page),
      ).toThrow();
    },
  );
  it("keeps search above the old scan cap, validates requested last-page position, and preserves raw units", () => {
    const result = readMarketCatalogPage(payload(1001, 12001), request(1001));
    expect(result.total).toBe(12001);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].tokenId).toBe("12000");
    expect(result.data[0].price).toBe("9007199254740993123456789");
    expect(
      Object.isFrozen(result) &&
        Object.isFrozen(result.data) &&
        Object.isFrozen(result.data[0]),
    ).toBe(true);
  });
  it.each([
    { runtime: false },
    { source: "other" },
    { schemaVersion: "2" },
    { q: "other" },
    { listingStatus: "all" },
    { sort: "oldest" },
    { page: 2 },
    { pageSize: 100 },
    { total: "13" },
    { total: -1 },
    { total: Infinity },
    { data: [] },
  ])("rejects old or mismatched envelope %o", (patch) => {
    expect(() =>
      readMarketCatalogPage({ ...payload(), ...patch }, request()),
    ).toThrow();
  });
  it("rejects duplicate identity, invalid row and ambiguous requests", () => {
    const body = payload();
    body.data[1] = body.data[0];
    expect(() => readMarketCatalogPage(body, request())).toThrow();
    const invalid = payload();
    invalid.data[0].tokenId = "1e3";
    expect(() => readMarketCatalogPage(invalid, request())).toThrow();
    const duplicate = request();
    duplicate.append("sort", "oldest");
    expect(() => readMarketCatalogPage(payload(), duplicate)).toThrow();
  });
  it("handles explicit empty results but refuses a page no longer present", () => {
    expect(readMarketCatalogPage(payload(1, 0), request()).data).toEqual([]);
    expect(() => readMarketCatalogPage(payload(2, 0), request(2))).toThrow();
  });
  it("fetches only the requested server page, checks cancellation and never supplies credentials", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(payload(2))),
    );
    const controller = new AbortController();
    const result = await fetchMarketCatalogPage(
      fetcher,
      "https://catalog.invalid",
      { q: "Ink%_!", listingStatus: "active", sort: "token" },
      2,
      controller.signal,
    );
    expect(result.data).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    controller.abort();
    await expect(
      fetchMarketCatalogPage(
        fetcher,
        "",
        emptyMarketCatalogFilters(),
        1,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses a failed request before decoding a response", async () => {
    await expect(
      fetchMarketCatalogPage(
        async () => new Response("unavailable", { status: 503 }),
        "",
        emptyMarketCatalogFilters(),
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow("503");
  });
});
