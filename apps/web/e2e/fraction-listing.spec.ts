import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * The fraction settlement surface — `PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6.
 *
 * `PRD.md` §3.2 makes a stage deliverable when its function is operable from a screen. The
 * signature-settled fixed-price path existed in `ArtFiMarket.sol` with nothing reaching it, and the
 * page said so in as many words; this surface is that screen.
 *
 * What these tests hold to is the honesty of the surface rather than a happy path. The market is not
 * deployed and the fraction figures on the page are still fixtures, so the panel must say what is
 * missing and offer nothing. A surface that showed a sale it could not settle would fail
 * `ACCEPTANCE.md` §7.7 the same way an unlabelled fixture does.
 */

const fractionPath = "/market/fractionals/blue-hour-archive";

test("the fraction asset page carries the settlement surface", async ({
  page,
}) => {
  await page.goto(fractionPath);
  await expect(
    page.getByRole("heading", { level: 1, name: "Blue Hour Archive" }),
  ).toBeVisible();
  await expect(page.getByText("Fractions, sold by signature")).toBeVisible();
});

test("an unconfigured market says so and offers no way to sign or settle", async ({
  page,
}) => {
  await page.goto(fractionPath);
  const panel = page.getByRole("region", {
    name: /Settlement on ArtFi is not configured/i,
  });
  await expect(panel).toBeVisible();
  for (const action of [
    /Sign the sale terms/i,
    /Settle this amount/i,
    /Approve exactly this many/i,
    /Withdraw this authorization/i,
    /Withdraw every authorization/i,
  ]) {
    await expect(panel.getByRole("button", { name: action })).toHaveCount(0);
  }
});

// The page tells the reader which of the two prerequisites is absent, rather than failing blank.
test("the surface names what is missing", async ({ page }) => {
  await page.goto(fractionPath);
  await expect(
    page.getByText("No market address is configured."),
  ).toBeVisible();
  await expect(
    page.getByText("No fraction token is configured."),
  ).toBeVisible();
});

/**
 * Mirror-only is a phase of one arc, not a competing position (`AGENTS.md` §1.1 invariant 6). An
 * unconfigured ArtFi settlement surface must not read as "fractions cannot be traded": they trade on
 * OpenSea too, and the page has to say so.
 */
test("an unconfigured surface still points at the venue that is open", async ({
  page,
}) => {
  await page.goto(fractionPath);
  await expect(
    page.getByText(/Fractions\s+trade on ArtFi and on OpenSea/i),
  ).toBeVisible();
});

// The fixture figures on this page describe no deployed token, and the settlement panel below them
// reads real state. A reader must not take the first for the second.
test("the fixture figures stay labelled beside the live surface", async ({
  page,
}) => {
  await page.goto(fractionPath);
  await expect(page.getByText("These figures are fixture data")).toBeVisible();
});

// The whole-artwork panel settles a different contract. It must not appear here.
test("the whole-artwork surface does not appear on a fraction page", async ({
  page,
}) => {
  await page.goto(fractionPath);
  await expect(
    page.getByText("The receipt token stays in your wallet until it sells."),
  ).toHaveCount(0);
});

test("the fraction surface is free of serious accessibility violations", async ({
  page,
}) => {
  await page.goto(fractionPath);
  await expect(page.getByText("Fractions, sold by signature")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
