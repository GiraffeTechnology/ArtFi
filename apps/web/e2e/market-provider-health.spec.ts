import { expect, test } from "@playwright/test";

test("stale provider data is visible and never presented as live", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], total: 0, runtime: true }),
    }),
  );
  await page.route("**/v1/market/health**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        source: "opensea",
        state: "stale",
        stale: true,
        realtimeConnected: true,
        consecutiveFailures: 0,
        observedAt: "2026-09-14T00:02:00Z",
        lastEventAt: "2026-09-14T00:00:00Z",
        freshnessLagSeconds: 120,
        staleAfterSeconds: 60,
        receivedAt: "2026-09-14T00:02:00Z",
        reportLagSeconds: 1,
        reportingStale: false,
        available: false,
      }),
    }),
  );

  await page.goto("/market/rwa");
  await expect(page.getByText("Provider data stale").first()).toBeVisible();
  await expect(
    page.getByText(/Mirrored records remain read-only and may be out of date/),
  ).toBeVisible();
  await expect(page.getByText(/Provider live/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /buy|bid|send transaction/i }),
  ).toHaveCount(0);
});

test("missing provider health fails closed without hiding attributed records", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], total: 0, runtime: true }),
    }),
  );
  await page.route("**/v1/market/health**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        status: 503,
        title: "Service Unavailable",
        detail: "Durable provider health is unavailable.",
      }),
    }),
  );

  await page.goto("/market/rwa");
  await expect(
    page.getByText("Provider status unavailable").first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Mirrored records remain read-only and are not presented as current/,
    ),
  ).toBeVisible();
  await expect(page.getByText("No OpenSea assets observed yet")).toBeVisible();
});
