import { expect, test } from "@playwright/test";

// The three product lines follow the client's 2026-10-02 clarification.
// These tests verify navigation and honest unavailable states, not live transactions.

test("the overview exposes exactly three actionable product entries", async ({
  page,
}) => {
  await page.goto("/");
  const products = page.getByRole("region", { name: "Three product lines" });
  await expect(products.locator("article")).toHaveCount(3);
  await expect(
    products.getByRole("link", { name: "Explore NFTs", exact: true }),
  ).toHaveAttribute("href", "/nft");
  await expect(
    products.getByRole("link", { name: "Explore whole-artwork RWA" }),
  ).toHaveAttribute("href", "/rwa");
  await expect(
    products.getByRole("link", { name: "Explore fractions & DAO" }),
  ).toHaveAttribute("href", "/market/fractionals");
  await expect(products).toContainText("without real-world asset backing");
  await expect(products).toContainText("pickup voucher or warehouse receipt");
  await expect(products).toContainText("original ArtFi workflow");
  await expect(page.getByLabel("Runtime availability")).toContainText(
    "No real assets or real money",
  );

  await products
    .getByRole("link", { name: "Explore NFTs", exact: true })
    .click();
  await expect(page).toHaveURL(/\/nft$/);
  await page.goBack();
  await products
    .getByRole("link", { name: "Explore whole-artwork RWA" })
    .click();
  await expect(page).toHaveURL(/\/rwa$/);
  await page.goBack();
  await products.getByRole("link", { name: "Explore fractions & DAO" }).click();
  await expect(page).toHaveURL(/\/market\/fractionals$/);
});

test("NFT keeps CCHS, OpenSea and independent Charity paths usable", async ({
  page,
}) => {
  await page.goto("/nft");
  await expect(page.getByRole("link", { name: "Visit CCHS" })).toHaveAttribute(
    "href",
    "https://cchsc.ca/",
  );
  await expect(
    page.getByRole("link", { name: "Visit OpenSea" }),
  ).toHaveAttribute("href", "https://opensea.io/");
  await expect(page.getByTestId("charity-edition-rights-notice")).toContainText(
    "no copyright, physical title",
  );

  await page
    .getByRole("link", { name: "Open Charity editions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Charity editions." }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "NFT", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Create a charity edition on Hoodi" })
    .click();
  await expect(page).toHaveURL(/\/create\/rwa\?standard=erc1155$/);
  await expect(page.getByRole("tab", { name: /ERC-1155/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Review and mint ERC-1155 on Hoodi" }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: /ERC-721/ }).click();
  await expect(page.getByRole("tab", { name: /ERC-721/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("whole RWA reaches the existing receipt and transaction surface", async ({
  page,
}) => {
  await page.goto("/rwa");
  await expect(page.getByTestId("prototype-data-notice")).toContainText(
    "not a live catalogue",
  );
  await expect(page.getByRole("main")).toContainText(
    "pickup voucher or warehouse receipt",
  );
  await expect(page.getByRole("main")).toContainText("ERC-8415");
  await expect(page.getByTestId("whole-rwa-issuance-paths")).toContainText(
    "does not issue ERC-8415 receipt tokens",
  );
  await page.getByRole("link", { name: "Open existing ERC-721 mint" }).click();
  await expect(page).toHaveURL(/\/create\/rwa$/);
  await expect(page.getByRole("tab", { name: /ERC-721/ })).toContainText(
    "does not implement ERC-8415 register projection",
  );
  await page.goBack();
  await expect(page).toHaveURL(/\/rwa$/);
  await page
    .getByRole("link", { name: "View Blue Hour Archive", exact: true })
    .click();
  await expect(page).toHaveURL(/\/market\/rwa\/blue-hour-archive$/);
  await expect(page.getByTestId("asset-holder-authority")).toContainText(
    "Registry of record",
  );
  await expect(page.locator("#whole-artwork-listing")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Whole-artwork RWA" })
    .click();
  await expect(page).toHaveURL(/\/rwa$/);
});

test("fractions retain trading entry points and the original Vault / DAO flow", async ({
  page,
}) => {
  await page.goto("/market/fractionals");
  await expect(page.getByTestId("prototype-data-notice")).toContainText(
    "prototype fixtures",
  );
  await page
    .getByRole("link", { name: "View Blue Hour Archive", exact: true })
    .click();
  await expect(page).toHaveURL(/\/market\/fractionals\/blue-hour-archive$/);
  await expect(page.locator("#fraction-listing")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Fractions & DAO" })
    .click();
  await page.getByRole("link", { name: "Create a Vault / open DAO" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Create the asset DAO in four controlled steps.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Step 1 · Create Vault" }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Fractions & DAO" })
    .click();
  await expect(page).toHaveURL(/\/market\/fractionals$/);
});

test("navigation keeps product entries and closes menus on newer navigation", async ({
  page,
}) => {
  await page.goto("/");
  const mobileToggle = page.locator(".mobile-menu summary");
  const mobile = await mobileToggle.isVisible();
  if (mobile) await mobileToggle.click();
  const nav = page.getByRole("navigation", {
    name: mobile ? "Mobile navigation" : "Primary navigation",
    exact: true,
  });
  await nav.getByRole("link", { name: "NFT", exact: true }).click();
  await expect(page).toHaveURL(/\/nft$/);
  if (mobile) {
    await expect(page.locator(".mobile-menu")).not.toHaveAttribute("open", "");
    await mobileToggle.click();
  } else {
    await page.locator(".tools-menu summary").click();
  }
  await nav.getByRole("link", { name: "Mint", exact: true }).click();
  await expect(page).toHaveURL(/\/create\/rwa$/);
  await expect(
    page.locator(mobile ? ".mobile-menu" : ".tools-menu"),
  ).not.toHaveAttribute("open", "");
  if (mobile) {
    await mobileToggle.click();
  } else {
    await page.locator(".tools-menu summary").click();
  }
  // Selecting the current route must also dismiss the menu.
  await nav.getByRole("link", { name: "Mint", exact: true }).click();
  await expect(
    page.locator(mobile ? ".mobile-menu" : ".tools-menu"),
  ).not.toHaveAttribute("open", "");
  await page.goBack();
  await expect(page).toHaveURL(/\/nft$/);
  await expect(
    page.locator(mobile ? ".mobile-menu" : ".tools-menu"),
  ).not.toHaveAttribute("open", "");
  await page.goForward();
  await expect(page).toHaveURL(/\/create\/rwa$/);
});

test("all inherited shared tools remain reachable from the overview", async ({
  page,
}) => {
  await page.goto("/");
  const tools = page.getByRole("navigation", {
    name: "ArtFi tools",
    exact: true,
  });
  for (const [name, href] of [
    ["Market mirror", "/market/rwa"],
    ["Activity", "/market/activity"],
    ["Charity", "/charity"],
    ["Mint", "/create/rwa"],
    ["Wallet", "/portfolio"],
    ["DAO", "/dao"],
    ["Projects", "/projects"],
    ["Operations", "/operations"],
  ]) {
    await expect(
      tools.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", href);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
