import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
type Reply = {
  status?: number;
  patch?: Record<string, unknown>;
  title?: string;
};
async function open(
  page: Page,
  reply: (query: URLSearchParams) => Promise<Reply> | Reply = () => ({}),
) {
  const calls: URLSearchParams[] = [];
  const bundle = readFileSync(process.env.ARTFI_MARKET_FIXTURE!, "utf8");
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://market-fixture.invalid") return route.abort();
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>',
      });
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: bundle,
      });
    if (url.pathname !== "/v1/market/assets") return route.abort();
    const query = url.searchParams;
    calls.push(query);
    const result = await reply(query);
    const current = Number(query.get("page"));
    const total = 12001;
    const data = Array.from(
      { length: Math.min(12, Math.max(0, total - (current - 1) * 12)) },
      (_, i) => ({
        source: "opensea",
        chain: "ethereum",
        contractAddress: "0x" + "a".repeat(40),
        tokenId: String((current - 1) * 12 + i),
        collectionSlug: `${result.title ?? "Collection"} ${(current - 1) * 12 + i}`,
        latestEventType: "item_listed",
        latestEventTimestamp: "2026-10-17T12:00:00Z",
        price: "9007199254740993123456789",
      }),
    );
    try {
      await route.fulfill({
        status: result.status ?? 200,
        json: {
          runtime: true,
          schemaVersion: "1",
          source: "opensea",
          page: current,
          pageSize: 12,
          q: query.get("q"),
          listingStatus: query.get("listingStatus"),
          sort: query.get("sort"),
          total,
          data,
          ...result.patch,
        },
      });
    } catch {
      /* A deliberately aborted request must not become a test retry. */
    }
  });
  await page.goto("http://market-fixture.invalid/");
  return calls;
}
test("one server page and direct last-page access work above the previous 10000-record scan cap", async ({
  page,
}) => {
  const calls = await open(page);
  await expect(page.locator(".market-mirror-card")).toHaveCount(12);
  await expect(
    page.getByText("12 shown · 12001 matched across the catalog"),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  await page.getByRole("button", { name: "Last page", exact: true }).click();
  await expect(page.locator(".market-mirror-card")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Collection 12000", exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1].get("page")).toBe("1001");
  await expect(
    page.getByRole("button", { name: "Last page", exact: true }),
  ).toBeDisabled();
});
test("search is submitted literally and filter/order changes apply on the server with page reset", async ({
  page,
}) => {
  const calls = await open(page);
  await expect(page.locator(".market-mirror-card")).toHaveCount(12);
  await page.getByRole("searchbox").fill("needle & sort=oldest");
  expect(calls).toHaveLength(1);
  await page
    .getByRole("button", { name: "Search catalog", exact: true })
    .click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].get("q")).toBe("needle & sort=oldest");
  expect(calls[1].getAll("sort")).toEqual(["newest"]);
  await expect(
    page.getByRole("button", { name: "Search catalog", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Listing status", exact: true })
    .selectOption("active");
  await expect.poll(() => calls.length).toBe(3);
  await page
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("token");
  await expect.poll(() => calls.length).toBe(4);
  expect(calls[3].get("page")).toBe("1");
  expect(calls[3].get("listingStatus")).toBe("active");
  expect(calls[3].get("sort")).toBe("token");
  expect(calls[3].get("q")).toBe("needle & sort=oldest");
});
test("a replaced request is aborted and its delayed results never overwrite the new search", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await open(page, async (query) => {
    if (query.get("listingStatus") === "all") {
      await held;
      return { title: "Obsolete" };
    }
    return { title: "Current" };
  });
  await expect.poll(() => calls.length).toBe(1);
  await page
    .getByRole("combobox", { name: "Listing status", exact: true })
    .selectOption("active");
  await expect(
    page.getByRole("heading", { name: "Current 0", exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("heading", { name: "Obsolete 0", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Current 0", exact: true }),
  ).toBeVisible();
});
test("a failed later page hides old rows and permits returning to the first page", async ({
  page,
}) => {
  await open(page, (query) =>
    query.get("page") === "2" ? { status: 503 } : {},
  );
  await expect(page.locator(".market-mirror-card")).toHaveCount(12);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("503");
  await expect(page.locator(".market-mirror-card")).toHaveCount(0);
  await page.getByRole("button", { name: "First page", exact: true }).click();
  await expect(page.locator(".market-mirror-card")).toHaveCount(12);
});
test("old API responses missing applied-query binding remain unavailable", async ({
  page,
}) => {
  await open(page, () => ({ patch: { q: undefined } }));
  await expect(page.getByRole("alert")).toContainText(
    "does not match this search",
  );
  await expect(page.locator(".market-mirror-card")).toHaveCount(0);
});
test("a stalled read times out without presenting a partial inventory", async ({
  page,
}) => {
  await page.clock.install();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await open(page, async () => {
    await held;
    return {};
  });
  await expect.poll(() => calls.length).toBe(1);
  await page.clock.fastForward(15000);
  await expect(page.getByRole("alert")).toContainText("refresh timeout");
  await expect(page.locator(".market-mirror-card")).toHaveCount(0);
  release();
});
test("unmount aborts its pending actual fetch", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await open(page, async () => {
    await held;
    return {};
  });
  await expect.poll(() => calls.length).toBe(1);
  const failed = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().includes("/v1/market/assets"),
  });
  await page.evaluate(() => window.marketCatalogFixture.unmount());
  expect((await failed).failure()?.errorText).toContain("ABORTED");
  release();
  await expect(page.locator(".live-market")).toHaveCount(0);
});
