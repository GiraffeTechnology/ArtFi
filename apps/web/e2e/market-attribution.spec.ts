import { expect, test } from "@playwright/test";

/**
 * Attribution on a mirrored record — #110 §2 XM.4 and XM.5.
 *
 * Explicit browser fixture, in the same sense as `market-unavailable.spec.ts`: the catalog response
 * is stubbed, so this proves **presentation**, not live venue connectivity. Presentation is the
 * thing under test — XM.4 is entirely about what each record carries when a reader looks at it.
 */

const observedAt = new Date(Date.now() - 14 * 60_000).toISOString();

function catalog(marketplaceUrl: string | undefined) {
  return {
    data: [
      {
        source: "opensea",
        chain: "ethereum",
        contractAddress: `0x${"ab".repeat(20)}`,
        tokenId: "42",
        collectionSlug: "artcch-mirror-fixture",
        latestEventType: "listing",
        latestEventTimestamp: observedAt,
        orderHash: `0x${"cd".repeat(32)}`,
        orderStatus: "active",
        price: "1000000000000000000",
        paymentSymbol: "ETH",
        ...(marketplaceUrl ? { marketplaceUrl } : {}),
      },
    ],
    total: 1,
    page: 1,
    pageSize: 100,
    runtime: true,
  };
}

async function serveCatalog(
  page: import("@playwright/test").Page,
  marketplaceUrl: string | undefined,
) {
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog(marketplaceUrl)),
    }),
  );
}

test("a mirrored record carries source, order id, time, freshness and a venue link", async ({
  page,
}) => {
  await serveCatalog(page, "https://opensea.io/assets/ethereum/0xabc/42");
  await page.goto("/market/rwa");

  const card = page.locator(".market-mirror-card").first();
  await expect(card).toContainText("OpenSea");
  await expect(card).toContainText("Active listing");
  await expect(card).toContainText("0xcdcdcdcd…cdcdcd");
  await expect(card).toContainText("14 minutes ago");

  const link = card.getByRole("link", { name: /open this record on opensea/i });
  await expect(link).toHaveAttribute(
    "href",
    "https://opensea.io/assets/ethereum/0xabc/42",
  );
  // It leaves ArtFi, so it opens away from the app and carries no referrer or opener.
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = (await link.getAttribute("rel")) ?? "";
  expect(rel).toContain("noopener");
  expect(rel).toContain("noreferrer");
});

test("the mirror states that execution completes on the venue", async ({
  page,
}) => {
  await serveCatalog(page, "https://opensea.io/assets/ethereum/0xabc/42");
  await page.goto("/market/rwa");
  await expect(page.locator(".market-mirror-card").first()).toContainText(
    "ArtFi creates, signs, matches, custodies, fulfils and settles nothing",
  );
  // Mirror-only means no trading control on this surface.
  await expect(
    page.getByRole("button", { name: /buy|bid|offer|fulfil|settle/i }),
  ).toHaveCount(0);
});

test("a record with no attributed link gets no link, not a constructed one", async ({
  page,
}) => {
  await serveCatalog(page, undefined);
  await page.goto("/market/rwa");
  const card = page.locator(".market-mirror-card").first();
  await expect(card).toContainText("No venue link was attributed");
  await expect(card.locator("a")).toHaveCount(0);
});

test("an off-host or non-HTTPS link is refused at the page, not rendered", async ({
  page,
}) => {
  await serveCatalog(page, "https://opensea.io.attacker.example/assets/x");
  await page.goto("/market/rwa");
  const card = page.locator(".market-mirror-card").first();
  await expect(card).toContainText("No venue link was attributed");
  await expect(card.locator("a")).toHaveCount(0);
});

test("a reader can exhaust cursor-paginated attributed activity without duplicates", async ({
  page,
}) => {
  await serveCatalog(page, "https://opensea.io/assets/ethereum/0xabc/42");
  const events = [
    ["event-1", "item_sold", "2026-08-19T04:00:03Z"],
    ["event-2", "item_transferred", "2026-08-19T04:00:02Z"],
    ["event-3", "item_listed", "2026-08-19T04:00:01Z"],
  ] as const;
  await page.route("**/v1/market/activity**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const selected = cursor ? events.slice(2) : events.slice(0, 2);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: selected.map(([eventId, eventType, eventTimestamp]) => ({
          eventId,
          schemaVersion: "1",
          source: "opensea",
          eventType,
          eventFamily: eventType === "item_sold" ? "sale" : "order",
          entityKey: "fixture",
          version: 1,
          chain: "ethereum",
          contractAddress: `0x${"ab".repeat(20)}`,
          tokenId: "42",
          marketplaceUrl: "https://opensea.io/assets/ethereum/0xabc/42",
          eventTimestamp,
          receivedAt: eventTimestamp,
          payload: {},
        })),
        ...(cursor ? {} : { nextCursor: "page-two" }),
        hasMore: !cursor,
        schemaVersion: "1",
        source: "opensea",
        execution: "external-deeplink-only",
        custody: false,
      }),
    });
  });

  await page.goto("/market/rwa");
  const card = page.locator(".market-mirror-card").first();
  await card.getByRole("button", { name: "View activity history" }).click();
  await expect(card.locator(".market-activity__panel li")).toHaveCount(2);
  await card.getByRole("button", { name: "Load more activity" }).click();
  await expect(card.locator(".market-activity__panel li")).toHaveCount(3);
  await expect(
    card.getByRole("button", { name: "Load more activity" }),
  ).toHaveCount(0);
  await expect(card).toContainText("item sold");
  await expect(card).toContainText("item transferred");
  await expect(card).toContainText("item listed");
});
