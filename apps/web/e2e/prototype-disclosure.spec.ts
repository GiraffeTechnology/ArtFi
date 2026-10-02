import { expect, test } from "@playwright/test";

/**
 * Fixture disclosure and holder authority — `AGENTS.md` §5, `ACCEPTANCE.md` §3 and §7.7,
 * `PRD.md` §1.0.5.
 *
 * `lib/catalog.ts` holds six invented artworks by six invented artists, with invented valuations
 * and provenance. Carrying them is legitimate — they are inherited prototype material and `PRD.md`
 * §2.1 says to preserve Class A surfaces. Letting a reader take them for a live catalogue is not.
 * These tests hold every surface that renders them to saying so.
 */

const fixtureSurfaces = [
  "/rwa",
  "/projects",
  "/projects/material-memory",
  "/market/rwa/blue-hour-archive",
  "/market/fractionals",
  "/market/fractionals/blue-hour-archive",
];

for (const path of fixtureSurfaces) {
  test(`${path} discloses that its catalogue is prototype data`, async ({
    page,
  }) => {
    await page.goto(path);
    const notice = page.getByTestId("prototype-data-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("prototype fixtures");
    await expect(notice).toContainText("not a live catalogue");
    await expect(notice).toContainText("not an observed market value");
  });
}

test("the live mirror is not labelled as prototype data", async ({ page }) => {
  // The disclosure must stay honest in both directions: the mirror reads runtime events, and
  // marking it as fixtures would be as wrong as leaving the fixtures unmarked.
  await page.goto("/market/rwa");
  await expect(page.getByTestId("prototype-data-notice")).toHaveCount(0);
});

test("the charity surface is not labelled as prototype data", async ({
  page,
}) => {
  await page.goto("/charity");
  await expect(page.getByTestId("prototype-data-notice")).toHaveCount(0);
});

test("a whole artwork states who the holder authority is", async ({ page }) => {
  await page.goto("/market/rwa/blue-hour-archive");
  const authority = page.getByTestId("asset-holder-authority");
  await expect(authority).toBeVisible();
  await expect(authority).toContainText("Registry of record");
  await expect(authority).toContainText("Authority for holdership");
  // The public Oracle read API has no holder address; references and statuses create no holder claim.
  await expect(authority).toContainText(
    "Holder unavailable through the public Oracle read API",
  );
  await expect(authority).toContainText("Authoritative for nothing");
  await expect(authority).toContainText("never resolves one by asserting");
});

test("a fraction page makes no whole-artwork holder claim", async ({
  page,
}) => {
  // Fractions are a different asset model (PRD §1.0.1 B); the registry-backed holder statement
  // belongs to the receipt asset and must not be copied onto them.
  await page.goto("/market/fractionals/blue-hour-archive");
  await expect(page.getByTestId("asset-holder-authority")).toHaveCount(0);
});

test("the product overview makes no fixture or live catalogue claim", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("prototype-data-notice")).toHaveCount(0);
  await expect(page.locator(".market-mirror-card")).toHaveCount(0);
  await expect(page.getByLabel("Runtime availability")).toContainText(
    "A visible workflow is not a claim that its contracts or services are configured",
  );
});

test("NFT editions do not silently fall back to a fixture catalogue", async ({
  page,
}) => {
  await page.goto("/nft");
  await expect(page.getByTestId("prototype-data-notice")).toHaveCount(0);
  await expect(page.locator(".charity-catalog")).toBeVisible();
  await expect(page.locator(".charity-catalog img")).toHaveCount(0);
});
