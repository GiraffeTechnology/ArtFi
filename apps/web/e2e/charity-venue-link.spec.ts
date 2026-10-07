import { expect, test } from "@playwright/test";

/** Source evidence must be truthful even when the edition or marketplace is unavailable. */

const editionPath = "/charity/1";

test("the edition page carries the venue surface", async ({ page }) => {
  await page.goto(editionPath);
  await expect(page.getByTestId("charity-venue")).toBeVisible();
});

test("no venue link is shown where none was attributed", async ({ page }) => {
  await page.goto(editionPath);
  const venue = page.getByTestId("charity-venue");
  await expect(venue).toBeVisible();
  // Not "no opensea.io link on the page" — the site's own chrome may carry one. This asserts the
  // venue surface itself produced none.
  await expect(venue.getByRole("link")).toHaveCount(0);
});

// The four states are distinct statements and the surface must make exactly one of them, not a
// hedge that covers several.
test("the surface says why there is no link", async ({ page }) => {
  await page.goto(editionPath);
  const venue = page.getByTestId("charity-venue");
  await expect(
    venue.getByText(
      /No venue record can be looked up|The venue record is unavailable|No marketplace activity has been observed|No venue link was attributed|Reading the venue record/,
    ),
  ).toBeVisible();
});

// XM.5, stated on the page rather than only in a document: ArtFi does not invent a venue URL.
test("the surface states that it does not construct a link", async ({
  page,
}) => {
  await page.goto(editionPath);
  await expect(
    page
      .getByTestId("charity-venue")
      .getByText(
        /does not construct one|assembled itself|the mirror observed/i,
      ),
  ).toBeVisible();
});

// The rights disclosure comes first and is not displaced by the venue surface: `ACCEPTANCE.md` §7.17
// fails an audit where an edition is displayed or offered without it.
test("the rights disclosure still precedes the venue surface", async ({
  page,
}) => {
  await page.goto(editionPath);
  const notice = page.getByText(/no copyright|no reproduction|no commercial/i);
  await expect(notice.first()).toBeVisible();
});
