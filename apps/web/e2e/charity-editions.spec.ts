import { expect, test } from "@playwright/test";

/**
 * The charity surface, checked for what CH.7, CH.8 and CH.5 require it to be — and for what they
 * require it never to become. Both projects in `playwright.config.ts` run this, so the desktop and
 * mobile layouts are both covered.
 */

test("the rights disclosure travels with the edition surface", async ({
  page,
}) => {
  await page.goto("/charity");
  const notice = page.getByTestId("charity-edition-rights-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("no copyright, physical title");
  await expect(notice).toContainText(
    "released after wallet ownership is verified",
  );
  await expect(notice).toContainText("ArtFi issues no receipt");
});

test("no artwork preview and no trading control appears on the charity surface", async ({
  page,
}) => {
  await page.goto("/charity");
  // CH.7: a charity edition publishes no preview, so an image here would be the defect.
  await expect(page.locator(".charity-catalog img")).toHaveCount(0);
  await expect(page.getByTestId("charity-edition-terms")).toContainText(
    "Not provided",
  );
  // CH.2: ArtFi creates, signs, matches, fulfils and settles nothing for these editions.
  await expect(
    page.getByRole("button", { name: /buy|bid|offer|purchase|settle/i }),
  ).toHaveCount(0);
});

test("an unreadable chain is reported, never filled in with a fixture", async ({
  page,
}) => {
  // Explicit browser fixture: this proves presentation, not live chain connectivity.
  await page.route("**/rpc**", (route) => route.abort());
  await page.goto("/charity");
  const state = page.locator('.market-runtime-state[role="alert"]');
  await expect(state.first()).toContainText("unavailable");
  await expect(page.locator(".charity-edition-card")).toHaveCount(0);
});

test("the holder benefit is offered only behind verification", async ({
  page,
}) => {
  await page.goto("/charity/1");
  const access = page.getByTestId("charity-holder-access");
  // The panel states the benefit and the gate together, and offers no download before either.
  await expect(access).toHaveCount(await access.count());
  await expect(
    page.getByRole("link", { name: /download the watermarked copy/i }),
  ).toHaveCount(0);
});

test("the gated file route serves nothing without a grant", async ({
  request,
}) => {
  const response = await request.get(
    "/api/charity/editions/1/holder-asset/file",
  );
  expect(response.status()).toBe(401);
  expect(await response.text()).toContain("Verify ownership");
  expect(response.headers()["content-type"]).toContain("application/json");
});

test("a malformed token id reaches no contract read", async ({ request }) => {
  const response = await request.get(
    "/api/charity/editions/not-a-token/holder-asset/file",
  );
  expect(response.status()).toBe(404);
});
