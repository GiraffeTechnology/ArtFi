import { expect, test } from "@playwright/test";

const contractA = "0x" + "a".repeat(40),
  contractB = "0x" + "b".repeat(40);
function event(id: string, contract: string, label: string) {
  return {
    eventId: id.repeat(64),
    source: "opensea",
    eventType: "item_sold",
    eventFamily: "sale",
    chain: "ethereum",
    eventTimestamp: "2026-10-15T10:00:00.000000Z",
    contractAddress: contract,
    tokenId: "1",
    collectionSlug: label,
    price: "100",
    paymentSymbol: "TEST_ONLY",
  };
}
function pageBody(data: unknown[], nextCursor?: string) {
  return {
    schemaVersion: "1",
    source: "opensea",
    custody: false,
    execution: "external-deeplink-only",
    data,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

// Browser fixtures exercise the UI contract; they are not a live venue or chain result.
test("contract filtering walks the API cursor and clearing returns to the full source", async ({
  page,
}) => {
  const queries: URLSearchParams[] = [];
  await page.route("**/v1/market/activity?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const filtered = query.get("contract") === contractB,
      older = query.has("cursor");
    await route.fulfill({
      json: filtered
        ? pageBody(
            [
              event(
                older ? "c" : "b",
                contractB,
                older ? "TEST_ONLY older filtered" : "TEST_ONLY filtered",
              ),
            ],
            older ? undefined : "cursor+opaque/=",
          )
        : pageBody([event("a", contractA, "TEST_ONLY unfiltered")]),
    });
  });
  await page.goto("/market/activity");
  await expect(page.getByTestId("activity-list")).toContainText(
    "TEST_ONLY unfiltered",
  );
  await page.getByRole("textbox", { name: "Contract address" }).fill(contractB);
  await page.getByRole("button", { name: "Apply contract filter" }).click();
  await expect(page.getByTestId("activity-list")).toContainText(
    "TEST_ONLY filtered",
  );
  await expect(page.getByTestId("activity-list")).not.toContainText(
    "TEST_ONLY unfiltered",
  );
  await page.getByTestId("activity-load-more").click();
  await expect(page.getByTestId("activity-list").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("activity-end")).toBeVisible();
  expect(queries.at(-1)?.get("cursor")).toBe("cursor+opaque/=");
  expect(queries.at(-1)?.get("contract")).toBe(contractB);
  expect(queries.at(-1)?.get("limit")).toBe("25");
  await page.getByRole("button", { name: "Clear contract filter" }).click();
  await expect(page.getByTestId("activity-list")).toContainText(
    "TEST_ONLY unfiltered",
  );
  expect(queries.at(-1)?.has("contract")).toBe(false);
  expect(queries.at(-1)?.has("cursor")).toBe(false);
  const calls = queries.length;
  await page.getByRole("textbox", { name: "Contract address" }).fill("invalid");
  await page.getByRole("button", { name: "Apply contract filter" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "complete 20-byte contract address",
  );
  expect(queries).toHaveLength(calls);
  await expect(page.getByTestId("activity-list")).toContainText(
    "TEST_ONLY unfiltered",
  );
});

test("a failed read stays distinct from an empty filtered history and can be retried", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/v1/market/activity?*", async (route) => {
    calls++;
    await route.fulfill(
      calls === 1
        ? { status: 503, json: { detail: "TEST_ONLY unavailable" } }
        : { json: pageBody([]) },
    );
  });
  await page.goto("/market/activity");
  await expect(page.getByTestId("activity-error")).toBeVisible();
  await expect(page.getByTestId("activity-empty")).toHaveCount(0);
  await expect(page.getByTestId("activity-end")).toHaveCount(0);
  await page.getByTestId("activity-load-more").click();
  await expect(page.getByTestId("activity-empty")).toBeVisible();
  await expect(page.getByTestId("activity-error")).toHaveCount(0);
  expect(calls).toBe(2);
});

test("a repeated cursor reports incomplete history rather than its end", async ({
  page,
}) => {
  await page.route("**/v1/market/activity?*", (route) =>
    route.fulfill({
      json: pageBody(
        [event("a", contractA, "TEST_ONLY cursor")],
        "same-cursor",
      ),
    }),
  );
  await page.goto("/market/activity");
  await expect(page.getByTestId("activity-list")).toBeVisible();
  await page.getByTestId("activity-load-more").click();
  await expect(page.getByTestId("activity-error")).toContainText(
    "repeated an activity cursor",
  );
  await expect(page.getByTestId("activity-end")).toHaveCount(0);
  await expect(page.getByTestId("activity-list").locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh this history" }).click();
  await expect(page.getByTestId("activity-error")).toHaveCount(0);
  await expect(page.getByTestId("activity-list").locator("li")).toHaveCount(1);
});
