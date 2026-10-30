import { expect, test } from "@playwright/test";

// Synthetic browser responses verify presentation only.
for (const mode of ["healthy", "delayed", "missing", "malformed"] as const) {
  test(`provider status remains truthful for ${mode} reports`, async ({
    page,
  }) => {
    await page.route("**/v1/market/assets**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runtime: true,
          schemaVersion: "1",
          source: "opensea",
          page: Number(query.get("page")),
          pageSize: 12,
          q: query.get("q"),
          listingStatus: query.get("listingStatus"),
          sort: query.get("sort"),
          total: 0,
          data: [],
        }),
      });
    });
    await page.route("**/v1/market/health**", (route) =>
      route.fulfill({
        status: mode === "missing" ? 404 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "1",
          source: "opensea",
          state: "healthy",
          stale: false,
          realtimeConnected: true,
          receivedAt: "2026-10-30T00:00:00Z",
          reportLagSeconds: 0,
          reportingStale: mode === "delayed",
          available: mode !== "delayed",
          ...(mode === "malformed" ? { realtimeConnected: false } : {}),
        }),
      }),
    );
    await page.goto("/market/rwa");
    const status = page.getByRole("status", {
      name: "Marketplace provider health",
    });
    await expect(status).toContainText(
      mode === "healthy"
        ? "Provider live"
        : mode === "delayed"
          ? "Provider report stale"
          : "Provider status unavailable",
    );
    if (mode !== "healthy")
      await expect(status).toContainText("may be out of date");
    await expect(
      page.getByRole("button", { name: "Search catalog", exact: true }),
    ).toBeEnabled();
  });
}
