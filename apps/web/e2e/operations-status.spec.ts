import { expect, test } from "@playwright/test";

/**
 * The operator status surface — #110 §2 M6.3, read-only.
 *
 * Explicit browser fixtures below: dependency answers are stubbed, so these prove **presentation**
 * and classification, not live infrastructure. The rules under test are the ones that make a status
 * page worth reading — an unreachable dependency is never green, and an absent check is never
 * rounded up to healthy.
 */

test("an unreachable dependency is reported, never shown as healthy", async ({
  page,
}) => {
  await page.route("**/healthz", (route) => route.abort());
  await page.route("**/v1/market/assets**", (route) => route.abort());
  await page.goto("/operations");

  const api = page.getByTestId("ops-row-api");
  await expect(api).toContainText("unavailable");
  await expect(api).not.toContainText("ok");
  await expect(page.getByTestId("operations-status")).toContainText(
    "could not be satisfied",
  );
});

test("an empty mirror is an absence, not a healthy quiet market", async ({
  page,
}) => {
  await page.route("**/healthz", (route) =>
    route.fulfill({ status: 200, body: "{}" }),
  );
  await page.route("**/v1/market/assets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], total: 0, runtime: true }),
    }),
  );
  await page.goto("/operations");

  const mirror = page.getByTestId("ops-row-mirror");
  await expect(mirror).toContainText("not-checked");
  await expect(mirror).toContainText("No mirrored observation");
});

test("the page states what it does not cover and names no endpoint", async ({
  page,
}) => {
  await page.goto("/operations");
  const status = page.getByTestId("operations-status");
  await expect(status).toContainText("Log aggregation, alerting");
  await expect(status).toContainText(
    "Nothing is stored and no alert is raised",
  );

  // ACCEPTANCE.md §7.8: no internal topology in the public UI.
  const body = (await page.locator("body").innerText()).toLowerCase();
  expect(body).not.toMatch(/https?:\/\//);
  expect(body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  expect(body).not.toContain("localhost");
});

test("no control on this page can change anything", async ({ page }) => {
  await page.goto("/operations");
  const buttons = page.getByTestId("operations-status").getByRole("button");
  await expect(buttons).toHaveCount(1);
  await expect(buttons.first()).toHaveText(/re-check/i);
});
