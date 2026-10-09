import { expect, test } from "@playwright/test";
import {
  isolatedSourceAsset,
  isolatedSourceCatalog,
} from "./rwa-catalog-fixture";
test("persisted catalog supports real record search, sorting, pagination and separate token identities", async ({
  page,
}) => {
  const records = Array.from({ length: 14 }, (_, index) => ({
    ...isolatedSourceAsset(),
    slug: `test-source-${index + 1}`,
    title: `TEST ONLY source asset ${String(index + 1).padStart(2, "0")}`,
    binding: {
      ...isolatedSourceAsset().binding,
      tokenId: String(index + 1),
      underlyingAssetId: `TEST_ONLY-source-${index + 1}`,
    },
  }));
  await isolatedSourceCatalog(page, records);
  await page.goto("/rwa");
  const catalog = page.getByRole("region", {
    name: "Approved whole-artwork catalog",
  });
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toHaveCount(12);
  await catalog.getByRole("button", { name: "Next assets" }).click();
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toHaveCount(2);
  await expect(
    catalog.getByRole("heading", { name: "TEST ONLY source asset 14" }),
  ).toBeVisible();
  await catalog.getByLabel("Search asset records").fill("asset 14");
  await catalog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toHaveCount(1);
  await catalog
    .getByRole("link", { name: "Inspect source-bound asset" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "TEST ONLY source asset 14",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Approved-source correspondence" }),
  ).toContainText("token 14");
  await expect(
    page.getByRole("region", { name: "Approved-source correspondence" }),
  ).toContainText("not fabricated valuations");
  await expect(page.locator("main")).not.toContainText("Mina Okafor");
});
test("catalog failure hides stale records and never promotes samples to live inventory", async ({
  page,
}) => {
  const state = await isolatedSourceCatalog(page);
  await page.goto("/market/fractionals");
  const catalog = page.getByRole("region", {
    name: "Approved fractional asset catalog",
  });
  await expect(
    catalog.getByRole("heading", { name: "TEST ONLY source-bound fractions" }),
  ).toBeVisible();
  state.status = 503;
  await catalog.getByRole("button", { name: "Refresh asset records" }).click();
  await expect(
    catalog.getByText(/No sample is shown as live inventory/),
  ).toBeVisible();
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toHaveCount(0);
});
