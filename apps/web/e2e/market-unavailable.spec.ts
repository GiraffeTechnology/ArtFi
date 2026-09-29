import { expect, test } from "@playwright/test";

test("missing persistence is unavailable, never a healthy empty market", async ({
  page,
}) => {
  // Explicit browser fixture: this proves presentation, not live provider connectivity.
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        status: 503,
        title: "Service Unavailable",
        detail: "Market persistence is unavailable.",
      }),
    }),
  );
  await page.goto("/market/rwa");
  const marketAlert = page.locator('.market-runtime-state[role="alert"]');
  await expect(marketAlert).toContainText("Live mirror unavailable");
  await expect(marketAlert).toContainText("No fixture is shown as live data");
  await expect(page.getByText("No OpenSea assets observed yet")).toHaveCount(0);
  await expect(page.locator(".market-mirror-card")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /buy|bid|send transaction/i }),
  ).toHaveCount(0);
});
