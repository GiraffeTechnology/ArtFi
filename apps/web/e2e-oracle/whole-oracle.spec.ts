import { expect, test } from "@playwright/test";
import { oracleReadFixtures } from "../src/test/oracle-fixtures";

const path = "/market/rwa/blue-hour-archive";
const endpoint = "**/api/assets/blue-hour-archive/oracle";
function success() {
  return { ok: true, ...oracleReadFixtures(), readAt: "2026-10-02T10:00:00Z" };
}
test("reports unconfigured, and another page never queries the bound token", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/assets/blue-hour-archive/oracle");
  expect(await response.json()).toEqual({
    ok: false,
    code: "ORACLE_NOT_CONFIGURED",
  });
  await page.goto(path);
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "not configured",
  );
  await expect(
    page.getByRole("button", { name: "Retry Oracle read" }),
  ).toBeEnabled();
  await page.goto("/market/rwa/weather-system-i");
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "belongs to another page",
  );
  await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
});

test("shows attributed public facts with no holder inference or mobile overflow", async ({
  page,
}) => {
  await page.route(endpoint, (route) => route.fulfill({ json: success() }));
  await page.goto(path);
  const authority = page.getByTestId("asset-holder-authority");
  const facts = page.getByTestId("oracle-facts");
  await expect(facts).toContainText("TEST_ONLY-registry-reference");
  await expect(facts).toContainText("IN_CUSTODY");
  await expect(facts).toContainText("2026-10-01T09:30:00Z");
  await expect(facts).toContainText("Certificate version");
  await expect(authority).toContainText(
    "Holder unavailable through the public Oracle read API",
  );
  await expect(authority).toContainText("do not establish physical title");
  await expect(authority).toContainText("not a registry holder claim");
  await expect(
    page.getByRole("button", { name: "Refresh Oracle status" }),
  ).toBeEnabled();
  expect(
    await authority.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await authority.screenshot({
    path: `test-results/oracle-panel-${test.info().project.name}.png`,
  });
});

test("retries failed reads, suppresses stale facts during refresh, and recovers", async ({
  page,
}) => {
  // StrictMode may abort and restart the initial read. A user-visible source
  // state changes only when the test performs the next user action.
  let phase: "unavailable" | "available" | "gone" = "unavailable";
  let requests = 0;
  let release: (() => void) | undefined;
  await page.route(endpoint, async (route) => {
    requests += 1;
    if (phase === "unavailable")
      return route.fulfill({
        status: 503,
        json: { ok: false, code: "ORACLE_UNAVAILABLE" },
      });
    if (phase === "gone") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return route.fulfill({
        status: 410,
        json: { ok: false, code: "ORACLE_RECORD_GONE" },
      });
    }
    await route.fulfill({ json: success() });
  });
  await page.goto(path);
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "could not be reached",
  );
  phase = "available";
  await page.getByRole("button", { name: "Retry Oracle read" }).click();
  await expect(page.getByTestId("oracle-facts")).toBeVisible();
  phase = "gone";
  const beforeRefresh = requests;
  await page.getByRole("button", { name: "Refresh Oracle status" }).click();
  await expect(
    page.getByRole("button", { name: "Reading Oracle…" }),
  ).toBeDisabled();
  await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  expect(requests).toBe(beforeRefresh + 1);
  release!();
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "returned 410",
  );
  phase = "available";
  await page.getByRole("button", { name: "Retry Oracle read" }).click();
  await expect(page.getByTestId("oracle-facts")).toBeVisible();
  expect(requests).toBe(beforeRefresh + 2);
});

test("labels 404 and mismatched bindings, and never fills missing facts", async ({
  page,
}) => {
  let phase: "missing" | "mismatched" | "available" = "missing";
  await page.route(endpoint, async (route) => {
    if (phase === "missing")
      return route.fulfill({
        status: 404,
        json: { ok: false, code: "TOKEN_NOT_FOUND" },
      });
    if (phase === "mismatched")
      return route.fulfill({
        status: 502,
        json: { ok: false, code: "BINDING_MISMATCH" },
      });
    const result = success();
    await route.fulfill({
      json: {
        ...result,
        token: { ...result.token, currentCertificate: null },
        asset: { ...result.asset, currentCertificate: null, warehouse: null },
      },
    });
  });
  await page.goto(path);
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "does not establish a registry rejection",
  );
  phase = "mismatched";
  await page.getByRole("button", { name: "Retry Oracle read" }).click();
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "does not match this page",
  );
  await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
  phase = "available";
  await page.getByRole("button", { name: "Retry Oracle read" }).click();
  await expect(page.getByTestId("oracle-facts")).toContainText(
    "No current certificate",
  );
  await expect(page.getByTestId("oracle-facts")).toContainText(
    "No warehouse record",
  );
});

test("shows differing source reads without deciding which has authority", async ({
  page,
}) => {
  const result = success();
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        ...result,
        asset: {
          ...result.asset,
          status: "FROZEN",
          currentCertificate: {
            ...result.asset.currentCertificate,
            certificateHash: "e".repeat(64),
          },
        },
      },
    }),
  );
  await page.goto(path);
  const facts = page.getByTestId("oracle-facts");
  await expect(facts).toContainText("These Oracle views differ");
  await expect(facts).toContainText("not an atomic snapshot");
  await expect(facts).toContainText("Current certificate · token read");
  await expect(facts).toContainText("VALID");
  await expect(facts).toContainText("FROZEN");
});

test("client navigation and Back cannot reuse the previous artwork's facts", async ({
  page,
}) => {
  await page.route(endpoint, (route) => route.fulfill({ json: success() }));
  await page.goto(path);
  await expect(page.getByTestId("oracle-facts")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Whole-artwork RWA" })
    .click();
  await page
    .getByRole("link", { name: "View Weather System I", exact: true })
    .click();
  await expect(page.getByTestId("oracle-unavailable")).toContainText(
    "belongs to another page",
  );
  await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByTestId("oracle-facts")).toContainText(
    "TEST_ONLY-registry-reference",
  );
});

test("offline refresh hides cached facts and resumes with a fresh response", async ({
  page,
  context,
}) => {
  let requests = 0;
  await page.route(endpoint, (route) => {
    requests++;
    return route.fulfill({ json: success() });
  });
  await page.goto(path);
  await expect(page.getByTestId("oracle-facts")).toBeVisible();
  const completedInitialRequests = requests;
  await context.setOffline(true);
  try {
    await page.getByRole("button", { name: "Refresh Oracle status" }).click();
    await expect(page.getByTestId("oracle-offline")).toContainText(
      "previous facts are hidden",
    );
    await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry Oracle read" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Retry Oracle read" }).click();
    await expect(page.getByTestId("oracle-facts")).toHaveCount(0);
    expect(requests).toBe(completedInitialRequests);
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId("oracle-facts")).toBeVisible();
  await expect(page.getByTestId("oracle-offline")).toHaveCount(0);
  expect(requests).toBe(completedInitialRequests + 1);
});
