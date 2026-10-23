import { expect, test } from "@playwright/test";

const asset = {
  source: "opensea",
  chain: "ethereum",
  contractAddress: "0x1111111111111111111111111111111111111111",
  tokenId: "42",
  collectionSlug: "artfi-test",
  latestEventType: "item_sold",
  latestEventTimestamp: "2026-09-13T01:02:03Z",
  orderStatus: "fulfilled",
  price: "1000000000000000",
  paymentSymbol: "ETH",
};

test("public-market history resumes without duplicate events or transaction actions", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [asset], total: 1, runtime: true }),
    }),
  );
  const requestedCursors: string[] = [];
  await page.route("**/v1/market/activity**", (route) => {
    const requestURL = new URL(route.request().url());
    expect(requestURL.searchParams.get("source")).toBe("opensea");
    expect(requestURL.searchParams.get("chain")).toBe("ethereum");
    expect(requestURL.searchParams.get("contract")).toBe(asset.contractAddress);
    expect(requestURL.searchParams.get("tokenId")).toBe("42");
    const cursor = requestURL.searchParams.get("cursor");
    if (cursor) requestedCursors.push(cursor);
    const firstEvent = {
      eventId: "a".repeat(64),
      source: "opensea",
      chain: "ethereum",
      contractAddress: asset.contractAddress,
      tokenId: "42",
      eventType: "item_sold",
      eventFamily: "sale",
      status: "fulfilled",
      price: "1000000000000000",
      paymentSymbol: "ETH",
      eventTimestamp: "2026-09-13T01:02:03Z",
    };
    const data = cursor
      ? [
          firstEvent,
          {
            eventId: "b".repeat(64),
            source: "opensea",
            chain: "ethereum",
            contractAddress: asset.contractAddress,
            tokenId: "42",
            eventType: "item_listed",
            eventFamily: "order",
            status: "active",
            price: "2000000000000000",
            paymentSymbol: "ETH",
            eventTimestamp: "2026-09-13T01:01:00Z",
          },
        ]
      : [firstEvent];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data,
        schemaVersion: "1",
        source: "opensea",
        execution: "external-deeplink-only",
        custody: false,
        hasMore: !cursor,
        nextCursor: cursor ? undefined : "opaque-next-page",
      }),
    });
  });

  await page.goto("/market/rwa");
  await page.getByRole("button", { name: "View transaction history" }).click();
  const history = page.getByRole("region", {
    name: "Transaction history for token 42",
  });
  await expect(history.getByText("item sold")).toBeVisible();
  await expect(history.getByText("1000000000000000 ETH")).toBeVisible();
  await page.getByRole("button", { name: "Load more activity" }).click();
  await expect(history.getByText("item listed")).toBeVisible();
  await expect(history.getByText("2000000000000000 ETH")).toBeVisible();
  await expect(history.getByText("item sold")).toHaveCount(1);
  expect(requestedCursors).toEqual(["opaque-next-page"]);
  await expect(page.locator('a[href*="opensea" i]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /buy|bid|sign|send transaction/i }),
  ).toHaveCount(0);
});

test("public-market history rejects activity for a different token identity", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [asset], total: 1, runtime: true }),
    }),
  );
  await page.route("**/v1/market/activity**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            eventId: "c".repeat(64),
            source: "opensea",
            chain: "ethereum",
            contractAddress: asset.contractAddress,
            tokenId: "43",
            eventType: "item_sold",
            eventFamily: "sale",
            status: "fulfilled",
            eventTimestamp: "2026-09-13T01:02:03Z",
          },
        ],
        schemaVersion: "1",
        source: "opensea",
        execution: "external-deeplink-only",
        custody: false,
        hasMore: false,
      }),
    }),
  );

  await page.goto("/market/rwa");
  await page.getByRole("button", { name: "View transaction history" }).click();
  const history = page.getByRole("region", {
    name: "Transaction history for token 42",
  });
  await expect(history.getByRole("alert")).toContainText(
    "crossed its read-only boundary",
  );
  await expect(history.getByText("item sold")).toHaveCount(0);
});

test("public-market history fails closed when runtime evidence is unavailable", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [asset], total: 1, runtime: true }),
    }),
  );
  await page.route("**/v1/market/activity**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        detail: "Attributed market activity is unavailable.",
      }),
    }),
  );

  await page.goto("/market/rwa");
  await page.getByRole("button", { name: "View transaction history" }).click();
  const history = page.getByRole("region", {
    name: "Transaction history for token 42",
  });
  await expect(history.getByRole("alert")).toContainText(
    "Attributed market activity is unavailable.",
  );
  await expect(
    page.getByText("No attributed activity has been observed"),
  ).toHaveCount(0);
});

test("public-market history rejects an incomplete pagination boundary", async ({
  page,
}) => {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [asset], total: 1, runtime: true }),
    }),
  );
  await page.route("**/v1/market/activity**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        schemaVersion: "1",
        source: "opensea",
        execution: "external-deeplink-only",
        custody: false,
        hasMore: true,
      }),
    }),
  );

  await page.goto("/market/rwa");
  await page.getByRole("button", { name: "View transaction history" }).click();
  const history = page.getByRole("region", {
    name: "Transaction history for token 42",
  });
  await expect(history.getByRole("alert")).toContainText(
    "crossed its read-only boundary",
  );
  await expect(
    page.getByText("No attributed activity has been observed"),
  ).toHaveCount(0);
});
