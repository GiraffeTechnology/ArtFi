import { test, expect } from "@playwright/test";
import { rwaCatalogFixture } from "../src/test/rwa-catalog-fixture";

// Isolated API fixtures; these are not live catalog or source acceptance.
test("whole catalog applies exact token filters across pages and clears them", async ({
  page,
}) => {
  const requests: URLSearchParams[] = [];
  const record = rwaCatalogFixture();
  await page.route("**/api/rwa/assets?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    requests.push(query);
    await route.fulfill({
      json: {
        data: [{ ...record, slug: "record-" + query.get("page") }],
        page: Number(query.get("page")),
        pageSize: 12,
        total: 13,
      },
    });
  });
  await page.goto("/rwa");
  const catalog = page.getByRole("region", {
    name: "Approved whole-artwork catalog",
  });
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toBeVisible();
  await catalog.getByLabel("Chain", { exact: true }).selectOption("560048");
  await catalog
    .getByLabel("Collection address", { exact: true })
    .fill(record.binding.collectionAddress);
  await catalog
    .getByLabel("Token ID", { exact: true })
    .fill(record.binding.tokenId);
  await catalog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(catalog.getByLabel("Applied catalog filters")).toContainText(
    "tokenId: 1",
  );
  await expect(
    catalog.getByRole("button", { name: "Next assets" }),
  ).toBeEnabled();
  await catalog.getByRole("button", { name: "Next assets" }).click();
  await expect(
    catalog.getByText("Page 2 · 13 records", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.get("collectionAddress")).toBe(
    record.binding.collectionAddress,
  );
  expect(requests.at(-1)?.get("tokenId")).toBe("1");
  await catalog
    .getByRole("button", { name: "Clear search and filters" })
    .click();
  await expect(
    catalog.getByText("Page 1 · 13 records", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)?.has("tokenId")).toBe(false);
  await expect(catalog.getByText(record.rights, { exact: true })).toBeVisible();
  await expect(
    catalog.getByText("TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT", {
      exact: true,
    }),
  ).toBeVisible();
});

test("fraction filters refuse invalid input before fetching and reject mismatched results", async ({
  page,
}) => {
  const record = rwaCatalogFixture();
  const fraction = "0x1000000000000000000000000000000000000009";
  let requests = 0;
  await page.route("**/api/rwa/assets?**", async (route) => {
    requests++;
    await route.fulfill({
      json: {
        data: [
          {
            ...record,
            section: "fractional",
            binding: { ...record.binding, fractionTokenAddress: fraction },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 12,
      },
    });
  });
  await page.goto("/market/fractionals");
  const catalog = page.getByRole("region", {
    name: "Approved fractional asset catalog",
  });
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toBeVisible();
  const before = requests;
  await catalog.getByLabel("Token ID", { exact: true }).fill("01");
  await catalog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(catalog.getByRole("alert")).toContainText("canonical decimal");
  expect(requests).toBe(before);
  await catalog.getByLabel("Token ID", { exact: true }).fill("");
  await catalog
    .getByLabel("Fraction token address", { exact: true })
    .fill("0x1000000000000000000000000000000000000008");
  await catalog.getByRole("button", { name: "Search", exact: true }).click();
  await expect(catalog.getByRole("status")).toHaveText(
    "The catalog returned a different asset binding.",
  );
  await expect(
    catalog.getByRole("link", { name: "Inspect source-bound asset" }),
  ).toHaveCount(0);
});
