import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyticsAssetFixture,
  analyticsPaymentToken,
  nativeAnalyticsFixture,
} from "../src/test/native-market-analytics-fixture";
import { rwaAssetIdentity } from "../src/lib/rwa-catalog";
const origin = "https://native-analytics-fixture.invalid";
function envelope() {
  const asset = analyticsAssetFixture();
  return {
    catalogIdentity: rwaAssetIdentity(asset),
    catalogRevision: asset.revision,
    analytics: nativeAnalyticsFixture(),
  };
}
async function mount(
  page: Page,
  onRequest: (route: Route) => Promise<void>,
  sourceRecord = false,
) {
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET")
      return route.abort();
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname === "/fixture.js" || url.pathname === "/style.css")
      return route.fulfill({
        contentType: url.pathname.endsWith(".js")
          ? "application/javascript"
          : "text/css",
        body: readFileSync(
          join(process.env.ARTFI_ANALYTICS_OUTPUT!, url.pathname.slice(1)),
        ),
      });
    if (url.pathname.endsWith("/analytics")) return onRequest(route);
    return route.abort();
  });
  await page.goto(sourceRecord ? `${origin}/?sourceRecord=1` : origin);
  await expect(
    page.getByRole("heading", { name: "Indexed fractional market analytics" }),
  ).toBeVisible();
}
async function submit(page: Page, token = analyticsPaymentToken) {
  await page.getByLabel("Payment-token address").fill(token);
  await page
    .getByRole("button", { name: "Read indexed analytics", exact: true })
    .click();
}
async function noOverflow(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("A configured viewport is required.");
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
  expect(widths.innerWidth).toBeLessThanOrEqual(viewport.width + 1);
}
test("shows exact source-bound observations and protects factual fields without a wallet or storage", async ({
  page,
}, info) => {
  const calls: {
    method: string;
    query: string;
    headers: Record<string, string>;
  }[] = [];
  await mount(page, async (route) => {
    const req = route.request();
    calls.push({
      method: req.method(),
      query: new URL(req.url()).search,
      headers: req.headers(),
    });
    await route.fulfill({ json: envelope() });
  });
  await expect(
    page.getByRole("button", { name: "Read indexed analytics", exact: true }),
  ).toBeDisabled();
  await submit(page);
  expect(await page.evaluate(() => document.characterSet)).toBe("UTF-8");
  await expect(
    page.getByText("Matched quantity · token base units", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("9007199254740993", { exact: true }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("GET");
  expect(new URLSearchParams(calls[0]!.query).get("paymentToken")).toBe(
    analyticsPaymentToken,
  );
  expect(
    Object.keys(Object.fromEntries(new URLSearchParams(calls[0]!.query))),
  ).toEqual(["paymentToken"]);
  expect(calls[0]!.headers.authorization).toBeUndefined();
  expect(calls[0]!.headers.cookie).toBeUndefined();
  expect(
    await page
      .getByText("27021597764222979", { exact: true })
      .evaluate(
        (node) =>
          node.hasAttribute("data-no-translate") &&
          node.hasAttribute("data-translation-skip"),
      ),
  ).toBe(true);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("exact-indexed-observations.png"),
    fullPage: true,
  });
});
test("never displays a response from another source revision", async ({
  page,
}) => {
  await mount(page, (route) =>
    route.fulfill({ json: { ...envelope(), catalogRevision: 99 } }),
  );
  await submit(page);
  await expect(page.getByText(/The source record changed/)).toBeVisible();
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toHaveCount(0);
});
test("clears prior amounts while a new currency request is pending and ignores its late predecessor", async ({
  page,
}) => {
  let first: Route | undefined,
    calls = 0;
  const other = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  await mount(page, async (route) => {
    calls++;
    if (calls === 1) {
      first = route;
      return;
    }
    await route.fulfill({
      json: {
        ...envelope(),
        analytics: { ...nativeAnalyticsFixture(), paymentToken: other },
      },
    });
  });
  await submit(page);
  await expect.poll(() => !!first).toBe(true);
  await page.getByLabel("Payment-token address").fill(other);
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Read indexed analytics", exact: true })
    .click();
  await expect(page.getByText(other, { exact: true })).toBeVisible();
  await first!.fulfill({ json: envelope() }).catch(() => undefined);
  await expect(
    page.getByText(analyticsPaymentToken, { exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(2);
});
test("retires a pending result when the source identity changes", async ({
  page,
}) => {
  let first: Route | undefined;
  await mount(page, async (route) => {
    first = route;
  });
  await submit(page);
  await expect.poll(() => !!first).toBe(true);
  await page.getByTestId("revise-source").click();
  await expect(page.getByLabel("Payment-token address")).toHaveValue("");
  await first!.fulfill({ json: envelope() }).catch(() => undefined);
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Read indexed analytics", exact: true }),
  ).toBeDisabled();
});
for (const status of [
  "history_limit_exceeded",
  "conflicting_indexed_evidence",
] as const)
  test(`keeps ${status} unavailable instead of presenting partial numbers`, async ({
    page,
  }) => {
    await mount(page, (route) =>
      route.fulfill({
        json: {
          ...envelope(),
          analytics: {
            ...nativeAnalyticsFixture(),
            status,
            tradeCount: 0,
            quantity: null,
            payment: null,
            distinctParticipants: 0,
            priceHistory: [],
          },
        },
      }),
    );
    await submit(page);
    await expect(
      page.getByText(/No partial totals are presented/),
    ).toBeVisible();
    await expect(
      page.getByText("27021597764222979", { exact: true }),
    ).toHaveCount(0);
    await noOverflow(page);
  });
test("retains a truthful unsupported binding after record refresh", async ({
  page,
}) => {
  let calls = 0;
  await mount(page, async (route) => {
    calls++;
    await route.fulfill({ json: envelope() });
  });
  await submit(page);
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toBeVisible();
  await page.getByTestId("remove-binding").click();
  await expect(
    page.getByText(/no supported native fraction market binding/),
  ).toBeVisible();
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
});
test("keyboard submits a single read and reports an unavailable backend without internal details", async ({
  page,
}) => {
  let calls = 0;
  await mount(page, async (route) => {
    calls++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "TEST_ONLY_INTERNAL_ERROR" }),
    });
  });
  await page.getByLabel("Payment-token address").fill(analyticsPaymentToken);
  await page.getByLabel("Payment-token address").press("Enter");
  await expect(
    page.getByText(/No sample totals are substituted/),
  ).toBeVisible();
  await expect(page.getByText("TEST_ONLY_INTERNAL_ERROR")).toHaveCount(0);
  expect(calls).toBe(1);
});

test("source evidence cards fit the configured viewport alongside analytics", async ({
  page,
}, info) => {
  await mount(page, (route) => route.fulfill({ json: envelope() }), true);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "TEST ONLY source record",
      exact: true,
    }),
  ).toBeVisible();
  await submit(page);
  await expect(
    page.getByText("27021597764222979", { exact: true }),
  ).toBeVisible();
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
  }));
  await info.attach("configured-viewport.json", {
    body: JSON.stringify({ viewport: page.viewportSize(), widths }),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath("source-evidence-layout.png"),
    fullPage: true,
  });
  await noOverflow(page);
});
