import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The mirrored activity history — Issue #110's external-marketplace baseline, `PRD.md` §4.8
 * XM.2–XM.4, and §3.2's delivery standard.
 *
 * `/v1/market/activity` existed with no screen reaching it and served at most the hundred most
 * recent events. §3.2 counts an endpoint no screen reaches as progress rather than a handover, so
 * the screen is the deliverable and these tests are about what it says when it cannot show data.
 *
 * No API is running here, so every assertion is on the honest-failure side: the page must say the
 * mirror is unreachable and must not present that as "no activity". Those are opposite statements
 * to a reader deciding whether a market is quiet or broken, and `ACCEPTANCE.md` §3 fails an audit
 * over a surface that renders but cannot execute its function while implying otherwise.
 */

const activityPath = "/market/activity";

test("the activity route carries the history surface", async ({ page }) => {
  await page.goto(activityPath);
  await expect(
    page.getByRole("heading", { level: 1, name: "The mirrored history." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Every mirrored event/ }),
  ).toBeVisible();
});

/**
 * `PRD.md` §3.2 asks that the function be operable from a screen on desktop **and** mobile. The two
 * layouts navigate differently — the primary nav is hidden on a narrow viewport and the same links
 * sit behind a menu — so this follows whichever one the viewport actually offers rather than
 * asserting the desktop shape twice.
 */
test("the history is reachable from navigation on this viewport", async ({
  page,
}) => {
  await page.goto("/");
  const menuToggle = page.locator("details.mobile-menu > summary");
  const navName = (await menuToggle.isVisible())
    ? "Mobile navigation"
    : "Primary navigation";
  if (navName === "Mobile navigation") {
    await menuToggle.click();
  } else {
    await page.locator("details.tools-menu > summary").click();
  }

  const link = page
    .getByRole("navigation", { name: navName })
    .getByRole("link", { name: "Activity", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${activityPath}$`));
});

/**
 * The distinction the surface exists to keep. With no API reachable it must report that, and must
 * not render the empty state — "the mirror has observed no activity" would be a claim about the
 * market made from a failed request.
 */
test("an unreachable mirror is not reported as an empty history", async ({
  page,
}) => {
  await page.goto(activityPath);
  await expect(page.getByTestId("activity-error")).toBeVisible();
  await expect(page.getByTestId("activity-empty")).toHaveCount(0);
  await expect(page.getByTestId("activity-list")).toHaveCount(0);
});

// This event history must remain distinct from the native order workflow.
test("the surface states that its history panel does not submit orders", async ({
  page,
}) => {
  await page.goto(activityPath);
  await expect(
    page.getByText(/history panel is read-only and does not submit orders/i),
  ).toBeVisible();
  await expect(
    page.getByText(/execution completes on the venue/i),
  ).toBeVisible();
});

// With nothing loaded there is no page to walk, so the surface offers no end-of-history claim.
test("no end-of-history claim is made before anything is read", async ({
  page,
}) => {
  await page.goto(activityPath);
  await expect(page.getByTestId("activity-end")).toHaveCount(0);
});

test("the activity surface is free of serious accessibility violations", async ({
  page,
}) => {
  await page.goto(activityPath);
  await expect(
    page.getByRole("heading", { level: 1, name: "The mirrored history." }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
