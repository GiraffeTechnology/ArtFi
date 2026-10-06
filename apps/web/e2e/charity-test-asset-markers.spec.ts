import { expect, test } from "@playwright/test";

/**
 * `PRD.md` §7.0 test-asset markers, the on-screen place.
 *
 * §7.0 names four places the markers must appear and the charity surfaces are the third. They were
 * absent, and a Hoodi run stopped on it — three of four is an isolation failure, not a warning.
 * These tests exist so the same gap fails here first, without a chain.
 *
 * The assertion is on the exact strings §7.0 names. A banner that says "testnet" in its own words
 * is what was already there and is what let the gap through: that the *site* is a testnet build is
 * a different statement from these *assets* carrying no value and no legal effect.
 */

const markers = ["TESTNET", "NO REAL-WORLD VALUE", "NO LEGAL EFFECT"] as const;
const surfaces = ["/charity", "/charity/1"] as const;

for (const path of surfaces) {
  test(`${path} carries all three §7.0 test-asset markers`, async ({
    page,
  }) => {
    await page.goto(path);
    const note = page.getByTestId("charity-test-asset-markers");
    await expect(note).toBeVisible();
    for (const marker of markers) {
      await expect(note.getByText(marker, { exact: true })).toBeVisible();
    }
  });
}

// The markers must survive a narrow viewport. A disclosure that only exists on desktop is absent
// for a mobile holder, and §7.0 does not carve one out.
test("the markers are present on mobile as well as desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of surfaces) {
    await page.goto(path);
    await expect(page.getByTestId("charity-test-asset-markers")).toBeVisible();
  }
});

/**
 * CH.7 as written, not as first over-read — and asserted by where an image comes from, not by what
 * its filename looks like.
 *
 * CH.7 is "public token **metadata** contains no artwork preview", and its own text allows an
 * external marketplace to show a generic missing-image treatment. `CH.6` forbids the **master**
 * reaching a browser. Neither forbids site chrome.
 *
 * A name-based guess is how this went wrong twice. The first Hoodi run was told to reject every
 * image element outright and correctly reported the two brand images; then the brand mark,
 * `/brand/artcch-logo-master.svg`, was flagged by a naive `master` pattern. Both are the same
 * mistake: inferring from a name instead of a source.
 *
 * A substring guess is how this went wrong twice. The brand mark is
 * `/brand/artcch-logo-master.svg` — a logo master, matched by a naive `master` pattern — and the
 * first Hoodi run was told to reject every image element outright. Both are the same mistake:
 * inferring from a name instead of a source.
 *
 * What `CH.6` and `CH.7` forbid is an artwork or master **object** reaching the browser. Those are
 * served, when they are served at all, through the charity API routes and the object store. Site
 * chrome is static and ships from `/brand/`. So the check is an allowlist of origins.
 */
test("every image on a charity surface is static brand chrome", async ({
  page,
}) => {
  for (const path of surfaces) {
    await page.goto(path);
    const sources = await page
      .locator("img")
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => (node as HTMLImageElement).getAttribute("src") ?? "",
        ),
      );
    for (const src of sources) {
      // `next/image` rewrites to `/_next/image?url=%2Fbrand%2F…`, so the origin is read after
      // decoding rather than from the attribute as written.
      const origin = decodeURIComponent(src);
      expect(origin).toContain("/brand/");
      expect(origin).not.toContain("/api/charity/");
      expect(origin).not.toContain("holder-asset");
    }
  }
});

// The row that says the preview is absent only renders once a series has loaded, so it needs a
// configured contract and belongs to the Hoodi run's step E. Asserting it here against an
// unconfigured page would pass for the wrong reason.
test("the page states that no preview is published", async ({ page }) => {
  await page.goto("/charity/1");
  await expect(
    page.getByText(/No artwork preview is published/i),
  ).toBeVisible();
});
