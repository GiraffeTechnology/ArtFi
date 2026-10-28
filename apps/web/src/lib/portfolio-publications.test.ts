import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialPortfolioPublicationFilter as initial,
  portfolioPublicationByteLimit,
  portfolioPublicationNavigation,
  portfolioPublicationQuery,
  readPortfolioPublicationFilter,
  readPortfolioPublicationPage,
  requestPortfolioPublications,
} from "./portfolio-publications";
import { administrationRequestTimeoutMs } from "./administration-transport";
import {
  publicationAsset,
  publicationOrder,
  publicationPage,
  publicationSeller,
} from "./portfolio-publication.test-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("personal native publication scope and page admission", () => {
  it.each(["whole", "fraction"] as const)(
    "reads exact %s terms without changing base-unit values",
    (kind) => {
      const row = publicationOrder({ kind });
      const input = { ...publicationPage(), data: [row] };
      const output = readPortfolioPublicationPage(input, publicationSeller, {
        ...initial,
        kind,
      });
      expect(output).toEqual(input);
      expect(output.data[0]).not.toBe(row);
      expect(output.data[0].intent).not.toBe(row.intent);
      expect(
        output.data[0].intent[kind === "whole" ? "price" : "maxAmount"],
      ).toBe("900719925474099300000001");
    },
  );
  it("fixes seller, chain and size while preserving supported server-side filters", () => {
    const filter = readPortfolioPublicationFilter(
      new URLSearchParams(
        `kind=fraction&page=2&assetAddress=${publicationAsset}`,
      ),
    );
    expect([...portfolioPublicationQuery(publicationSeller, filter)]).toEqual([
      ["chainId", "560048"],
      ["sellerAddress", publicationSeller],
      ["page", "2"],
      ["pageSize", "10"],
      ["kind", "fraction"],
      ["assetAddress", publicationAsset],
    ]);
  });
  it.each([
    "sellerAddress=0x1000000000000000000000000000000000000002",
    "chainId=1",
    "pageSize=100",
    "page=0",
    "page=01",
    "page=1000001",
    "kind=whole&kind=fraction",
    "kind=unknown",
    "assetAddress=bad",
    "page=",
    "provider=https://foreign.invalid",
  ])("refuses identity overrides and unsupported filters: %s", (query) => {
    expect(() =>
      readPortfolioPublicationFilter(new URLSearchParams(query)),
    ).toThrow();
  });
  it.each([
    {
      ...publicationPage(),
      data: [publicationOrder({ seller: publicationAsset })],
    },
    { ...publicationPage(), data: [publicationOrder({ kind: "fraction" })] },
    {
      ...publicationPage(),
      data: [{ ...publicationOrder(), createdAt: undefined }],
    },
    {
      ...publicationPage(),
      data: [{ ...publicationOrder(), createdAt: "2026-10-28T00:00:00+00:00" }],
    },
    {
      ...publicationPage(),
      data: [{ ...publicationOrder(), intentHash: "0x" + "0".repeat(64) }],
    },
    { ...publicationPage(), data: [publicationOrder(), publicationOrder()] },
    { ...publicationPage(), page: 2 },
  ])(
    "refuses an entire foreign, ambiguous or malformed publication page",
    (value) => {
      expect(() =>
        readPortfolioPublicationPage(value, publicationSeller, {
          ...initial,
          kind: "whole",
        }),
      ).toThrow();
    },
  );
  it("allows probing beyond a full page despite an older non-atomic count", () => {
    const page = {
      data: Array.from({ length: 10 }, (_, n) =>
        publicationOrder({ salt: String(n) }),
      ),
      total: 0,
      page: 1,
      pageSize: 10,
    };
    const read = readPortfolioPublicationPage(page, publicationSeller, initial);
    expect(portfolioPublicationNavigation(read)).toMatchObject({
      previous: false,
      next: true,
      reportedCountChanged: true,
    });
  });
  it("does not treat an empty later page or the query ceiling as complete account history", () => {
    expect(
      portfolioPublicationNavigation({
        ...publicationPage(),
        data: [],
        total: 0,
        page: 2,
      }),
    ).toMatchObject({
      previous: true,
      next: false,
      reportedCountChanged: false,
    });
    expect(
      portfolioPublicationNavigation({
        ...publicationPage(),
        page: 1_000_000,
        total: 10_000_001,
      }),
    ).toMatchObject({ next: false, queryLimitReached: true });
  });
});

describe("private publication browser transport", () => {
  it("uses only the fixed same-origin private route and snapshots the filters", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(publicationPage()));
    vi.stubGlobal("fetch", request);
    const filter = { ...initial };
    const pending = requestPortfolioPublications(
      publicationSeller,
      filter,
      new AbortController().signal,
    );
    filter.kind = "fraction";
    filter.page = 2;
    await expect(pending).resolves.toEqual(publicationPage());
    expect(request.mock.calls[0][0]).toBe(
      `/api/portfolio/${publicationSeller}/orders?page=1`,
    );
    expect(request.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
  });
  it("rejects an invalid client filter as a promise without starting fetch", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      requestPortfolioPublications(
        publicationSeller,
        { ...initial, page: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 503])(
    "does not treat HTTP%s as an empty publication list",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { secret: "TEST_ONLY_PRIVATE_DIAGNOSTIC" },
              { status },
            ),
          ),
      );
      const result = requestPortfolioPublications(
        publicationSeller,
        initial,
        new AbortController().signal,
      );
      await expect(result).rejects.toThrow(
        "Published sale records are unavailable",
      );
    },
  );
  it("rejects a body over the actual-byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("x".repeat(portfolioPublicationByteLimit + 1), {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    await expect(
      requestPortfolioPublications(
        publicationSeller,
        initial,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("bounds stalled headers that ignore abort and disposes a late response", async () => {
    vi.useFakeTimers();
    let release!: (value: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    const pending = requestPortfolioPublications(
      publicationSeller,
      initial,
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(administrationRequestTimeoutMs + 1);
    await assertion;
    const late = Response.json(publicationPage());
    const cancel = vi.spyOn(late.body!, "cancel");
    release(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("retires a cancelled request even when the body never finishes", async () => {
    const parent = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new ReadableStream(), {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    const pending = requestPortfolioPublications(
      publicationSeller,
      initial,
      parent.signal,
    );
    const assertion = expect(pending).rejects.toThrow();
    await Promise.resolve();
    parent.abort();
    await assertion;
  });
});
