import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The whole-artwork settlement surface — `PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6.
 *
 * What these tests hold to is the honesty of the surface, not the happy path. The market is not
 * deployed and the catalogue is still fixtures, so the panel must say what is missing and offer
 * nothing. A surface that showed a sale it could not settle would fail `ACCEPTANCE.md` §7.7 the
 * same way an unlabelled fixture does.
 */

const assetPath = "/market/rwa/blue-hour-archive";

test("the whole-artwork asset page carries the settlement surface", async ({
  page,
}) => {
  await page.goto(assetPath);
  await expect(
    page.getByRole("heading", { level: 1, name: "Blue Hour Archive" }),
  ).toBeVisible();
  await expect(page.getByText("Sale by signature")).toBeVisible();
});

test("an unconfigured market says so and offers no way to sign or settle", async ({
  page,
}) => {
  await page.goto(assetPath);
  const panel = page.getByRole("region", {
    name: /Settlement on ArtFi is not configured/i,
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /Sign the sale terms/i }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /Settle this sale/i }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /Approve the market/i }),
  ).toHaveCount(0);
});

// The page tells the reader which of the two prerequisites is absent, rather than failing blank.
test("the surface names what is missing", async ({ page }) => {
  await page.goto(assetPath);
  await expect(
    page.getByText("No market address is configured."),
  ).toBeVisible();
  await expect(
    page.getByText("No artwork contract is configured."),
  ).toBeVisible();
});

// Fractions keep their own path. The whole-artwork panel must not appear there.
test("the fractional page does not show the whole-artwork settlement surface", async ({
  page,
}) => {
  await page.goto("/market/fractionals/blue-hour-archive");
  await expect(page.getByText("Sale by signature")).toHaveCount(0);
  await expect(
    page.getByText("Fraction trading has no screen yet"),
  ).toBeVisible();
});

// The retired stage ladder in docs/ROADMAP.md is not a gate. No surface may cite it as one.
test("no surface cites the retired stage ladder", async ({ page }) => {
  for (const path of [assetPath, "/market/fractionals/blue-hour-archive"]) {
    await page.goto(path);
    await expect(page.getByText(/unlocks in Stage \d/i)).toHaveCount(0);
    await expect(page.getByText(/pending Stage \d/i)).toHaveCount(0);
  }
});

test("the settlement surface is free of serious accessibility violations", async ({
  page,
}) => {
  await page.goto(assetPath);
  await expect(page.getByText("Sale by signature")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
