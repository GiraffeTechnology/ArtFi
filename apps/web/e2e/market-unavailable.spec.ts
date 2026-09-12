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

for (const recovery of ["manual", "polling"] as const) {
  test(`failed refresh hides old listings and recovers through ${recovery}`, async ({
    page,
  }) => {
    await page.clock.install();
    let unavailable = false;
    let requests = 0;
    let releaseRetry: (() => void) | undefined;
    await page.route("**/v1/market/assets**", async (route) => {
      requests += 1;
      if (recovery === "manual" && !unavailable && requests > 1) {
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
      }
      return route.fulfill({
        status: unavailable ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          unavailable
            ? { detail: "Market persistence is unavailable." }
            : {
                runtime: true,
                total: 1,
                data: [
                  {
                    source: "opensea",
                    chain: "test-only",
                    contractAddress:
                      "0x0000000000000000000000000000000000000001",
                    tokenId: "1",
                    collectionSlug: "Recovery test collection",
                    latestEventType: "listing",
                    latestEventTimestamp: "2026-09-12T00:00:00Z",
                    orderHash: "test-order",
                    orderStatus: "active",
                  },
                ],
              },
        ),
      });
    });
    await page.goto("/market/rwa");
    const cards = page.locator(".market-mirror-card");
    const alert = page.locator('.market-runtime-state[role="alert"]');
    await expect(cards).toHaveCount(1);
    await page.getByRole("searchbox").fill("Recovery test");
    await page
      .getByRole("combobox", { name: "Listing status", exact: true })
      .selectOption("active");

    unavailable = true;
    await page.clock.fastForward(15_000);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Live mirror unavailable");
    await expect(cards).toHaveCount(0);
    await expect(
      page.getByText("Market data unavailable", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText("No OpenSea assets observed yet")).toHaveCount(
      0,
    );

    const failedRequests = requests;
    unavailable = false;
    if (recovery === "manual") {
      await page.getByRole("button", { name: "Retry market data" }).click();
      await expect(
        page.getByRole("button", { name: "Retrying…" }),
      ).toBeDisabled();
      await expect.poll(() => requests).toBe(failedRequests + 1);
      await page.clock.fastForward(15_000);
      expect(requests).toBe(failedRequests + 1);
      await expect(cards).toHaveCount(0);
      releaseRetry?.();
    } else {
      await page.clock.fastForward(15_000);
    }
    await expect(cards).toHaveCount(1);
    await expect(alert).toHaveCount(0);
    expect(requests).toBeGreaterThan(failedRequests);
    await expect(page.getByRole("searchbox")).toHaveValue("Recovery test");
    await expect(
      page.getByRole("combobox", { name: "Listing status", exact: true }),
    ).toHaveValue("active");
  });
}
