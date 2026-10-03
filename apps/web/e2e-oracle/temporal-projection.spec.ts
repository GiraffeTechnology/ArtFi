import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { projectionFixture } from "../src/test/oracle-projection-fixtures";

const path = "/market/rwa/blue-hour-archive";
const endpoint = "**/api/assets/blue-hour-archive/projection?*";
const calls = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
  const recorded: string[] = [];
  calls.set(page, recorded);
  await page.exposeFunction(
    "__recordProjectionWalletCall",
    (method: string) => {
      recorded.push(method);
    },
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      ethereum: {
        on() {},
        removeListener() {},
        async request({ method }: { method: string }) {
          await (
            window as unknown as {
              __recordProjectionWalletCall: (method: string) => Promise<void>;
            }
          ).__recordProjectionWalletCall(method);
          if (method === "eth_accounts") return [];
          if (method === "eth_chainId") return "0x88bb0";
          throw new Error("Read-only TEST_ONLY projection journey");
        },
      },
    });
  });
});
test.afterEach(async ({ page }) => {
  expect(
    calls
      .get(page)!
      .filter((method) => !["eth_accounts", "eth_chainId"].includes(method)),
  ).toEqual([]);
});
test("shows temporal holder separately from position, precise history, and no mobile overflow", async ({
  page,
}) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: projectionFixture(
        new URL(route.request().url()).searchParams.get("instant")!,
      ),
    }),
  );
  await page.goto(path);
  const panel = page.getByRole("region", {
    name: "ERC-8415 register projection",
  });
  await expect(page.getByTestId("projection-facts")).toBeVisible();
  await panel.getByLabel("Historical instant (Unix seconds)").fill("1500");
  await panel.getByRole("button", { name: "Read this instant" }).click();
  await expect(panel).toContainText("1500 Unix seconds");
  await expect(panel).toContainText(
    "The tradeable position differs from the recorded holder",
  );
  await expect(panel).toContainText("Final for the queried instant");
  await expect(panel).toContainText("not an atomic chain snapshot");
  await expect(panel).toContainText("does not report settlement gaps");
  expect(
    await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  const axe = await new AxeBuilder({ page })
    .include('[aria-label="ERC-8415 register projection"]')
    .analyze();
  expect(
    axe.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await panel.screenshot({
    path: `test-results/temporal-projection-${test.info().project.name}.png`,
  });
});
test("uncovered history keeps false finality without inventing a holder, and rejects invalid time", async ({
  page,
}) => {
  let requests = 0;
  await page.route(endpoint, (route) => {
    requests++;
    const instant = new URL(route.request().url()).searchParams.get("instant")!;
    const result = projectionFixture(instant);
    if (instant === "999") {
      result.entry = { ok: false, code: "INSTANT_NOT_COVERED" };
      result.holder = { ok: false, code: "INSTANT_NOT_COVERED" };
      result.finality = { ok: true, value: false };
    }
    return route.fulfill({ json: result });
  });
  await page.goto(path);
  await expect(page.getByTestId("projection-facts")).toBeVisible();
  const input = page.getByLabel("Historical instant (Unix seconds)");
  await input.fill("999");
  await page.getByRole("button", { name: "Read this instant" }).click();
  await expect(page.getByTestId("projection-facts")).toContainText(
    "does not cover this instant",
  );
  await expect(page.getByTestId("projection-facts")).toContainText(
    "Not final for the queried instant",
  );
  const before = requests;
  await input.fill("18446744073709551616");
  await page.getByRole("button", { name: "Read this instant" }).click();
  await expect(page.getByRole("alert")).toContainText("uint64");
  expect(requests).toBe(before);
});
test("refresh and offline recovery hide previous facts, and source failure never becomes finality", async ({
  page,
  context,
}) => {
  let unavailable = false;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: unavailable ? 503 : 200,
      json: unavailable
        ? { ok: false, code: "PROJECTION_SOURCE_UNAVAILABLE" }
        : projectionFixture(
            new URL(route.request().url()).searchParams.get("instant")!,
          ),
    }),
  );
  await page.goto(path);
  await expect(page.getByTestId("projection-facts")).toBeVisible();
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Refresh register projection" })
    .click();
  await expect(page.getByTestId("projection-offline")).toBeVisible();
  await expect(page.getByTestId("projection-facts")).toHaveCount(0);
  unavailable = true;
  await context.setOffline(false);
  await expect(page.getByTestId("projection-unavailable")).toContainText(
    "did not answer",
  );
  unavailable = false;
  await page
    .getByRole("button", { name: "Refresh register projection" })
    .click();
  await expect(page.getByTestId("projection-facts")).toBeVisible();
});
test("another artwork never inherits projection facts and Back/Forward remain read-only", async ({
  page,
  request,
}) => {
  const invalid = await request.get(
    "/api/assets/blue-hour-archive/projection?instant=1500&url=https://invalid.test",
  );
  expect(invalid.status()).toBe(400);
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: projectionFixture(
        new URL(route.request().url()).searchParams.get("instant")!,
      ),
    }),
  );
  await page.goto(path);
  await expect(page.getByTestId("projection-facts")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Whole-artwork RWA" })
    .click();
  await page
    .getByRole("link", { name: "View Weather System I", exact: true })
    .click();
  await expect(page.getByTestId("projection-unavailable")).toContainText(
    "belongs to another page",
  );
  await expect(page.getByTestId("projection-facts")).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(page.getByTestId("projection-facts")).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId("projection-facts")).toHaveCount(0);
});
