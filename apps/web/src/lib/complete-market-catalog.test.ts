import { describe, expect, it, vi } from "vitest";
import { readCompleteMarketCatalog } from "./complete-market-catalog";

const address = "0x" + "a".repeat(40);
const item = (id: number) => ({
  source: "opensea",
  chain: "ethereum",
  contractAddress: address,
  tokenId: String(id),
  latestEventType: "item_listed",
  latestEventTimestamp: "2026-10-17T12:00:00.123456Z",
  price: "9007199254740993123456789",
});
const page = (data: unknown[], total: number, current = 1) => ({
  data,
  total,
  page: current,
  pageSize: 100,
  schemaVersion: "1",
  source: "opensea",
  runtime: true,
});
const response = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => data,
});
const signal = () => new AbortController().signal;

describe("complete mirrored catalog scan", () => {
  it("reads every validated page before returning, preserving raw base units and immutable rows", async () => {
    const first = Array.from({ length: 100 }, (_, i) => item(i));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(page(first, 101)))
      .mockResolvedValueOnce(response(page([item(100)], 101, 2)));
    const rows = await readCompleteMarketCatalog(fetcher, "", signal());
    expect(rows).toHaveLength(101);
    expect(rows[100].price).toBe("9007199254740993123456789");
    expect(Object.isFrozen(rows) && rows.every(Object.isFrozen)).toBe(true);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/v1/market/assets?source=opensea&page=1&pageSize=100",
      "/v1/market/assets?source=opensea&page=2&pageSize=100",
    ]);
    expect(
      fetcher.mock.calls.every(
        (call) =>
          call[1].cache === "no-store" &&
          call[1].credentials === "omit" &&
          call[1].redirect === "error",
      ),
    ).toBe(true);
  });
  it("accepts only explicit complete empty inventory", async () => {
    expect(
      await readCompleteMarketCatalog(
        async () => response(page([], 0)),
        "",
        signal(),
      ),
    ).toEqual([]);
  });
  it.each([NaN, Infinity, -1, 1.5, "1", null])(
    "rejects malformed totals %s",
    async (total) => {
      await expect(
        readCompleteMarketCatalog(
          async () => response({ ...page([], 0), total }),
          "",
          signal(),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses the old silent 100-page truncation before starting an oversized scan", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(
        page(
          Array.from({ length: 100 }, (_, i) => item(i)),
          10001,
        ),
      ),
    );
    await expect(
      readCompleteMarketCatalog(fetcher, "", signal()),
    ).rejects.toThrow("complete-scan limit");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { runtime: false },
    { source: "other" },
    { schemaVersion: "2" },
    { page: 2 },
    { pageSize: 12 },
    { data: {} },
  ])("rejects mismatched response envelope %o", async (patch) => {
    await expect(
      readCompleteMarketCatalog(
        async () => response({ ...page([item(1)], 1), ...patch }),
        "",
        signal(),
      ),
    ).rejects.toThrow();
  });
  it("rejects short or empty intermediate pages, excess rows and count changes", async () => {
    for (const body of [
      page([], 1),
      page([item(0)], 2),
      page([item(0), item(1)], 1),
    ]) {
      await expect(
        readCompleteMarketCatalog(async () => response(body), "", signal()),
      ).rejects.toThrow();
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          page(
            Array.from({ length: 100 }, (_, i) => item(i)),
            101,
          ),
        ),
      )
      .mockResolvedValueOnce(response(page([item(100)], 102, 2)));
    await expect(
      readCompleteMarketCatalog(fetcher, "", signal()),
    ).rejects.toThrow();
  });
  it("detects duplicates within and across pages using canonical identity rather than display labels", async () => {
    const duplicate = {
      ...item(1),
      contractAddress: address.toUpperCase().replace("0X", "0x"),
    };
    await expect(
      readCompleteMarketCatalog(
        async () => response(page([item(1), duplicate], 2)),
        "",
        signal(),
      ),
    ).rejects.toThrow();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          page(
            Array.from({ length: 100 }, (_, i) => item(i)),
            101,
          ),
        ),
      )
      .mockResolvedValueOnce(response(page([item(99)], 101, 2)));
    await expect(
      readCompleteMarketCatalog(fetcher, "", signal()),
    ).rejects.toThrow();
  });
  it.each([
    { tokenId: "1.5" },
    { tokenId: "01" },
    { tokenId: (1n << 256n).toString() },
    { latestEventTimestamp: "invalid" },
    { contractAddress: "0xabc" },
    { chain: "" },
    { source: "other" },
    { collectionSlug: {} },
  ])("rejects unsafe runtime row %o", async (patch) => {
    await expect(
      readCompleteMarketCatalog(
        async () => response(page([{ ...item(1), ...patch }], 1)),
        "",
        signal(),
      ),
    ).rejects.toThrow();
  });
  it("propagates cancellation before requests and after delayed JSON without exposing partial results", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      readCompleteMarketCatalog(fetcher, "", controller.signal),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const later = new AbortController();
    await expect(
      readCompleteMarketCatalog(
        async () => ({
          ok: true,
          status: 200,
          json: async () => {
            later.abort();
            return page([item(1)], 1);
          },
        }),
        "",
        later.signal,
      ),
    ).rejects.toThrow();
  });
  it("does not publish a successful prefix when a later request fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          page(
            Array.from({ length: 100 }, (_, i) => item(i)),
            101,
          ),
        ),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      });
    await expect(
      readCompleteMarketCatalog(fetcher, "", signal()),
    ).rejects.toThrow("503");
  });
});
