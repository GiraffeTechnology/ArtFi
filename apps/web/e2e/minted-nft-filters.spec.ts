import { test, expect } from "@playwright/test";
// API fixtures only; not real MySQL, chain, mint or venue acceptance.
test("mint filters stay on the server query across pages and clear back to page one", async ({
  page,
}) => {
  const requests: URLSearchParams[] = [];
  await page.route("**/v1/nfts?**", async (route) => {
    const q = new URL(route.request().url()).searchParams;
    requests.push(q);
    await route.fulfill({
      json: {
        runtime: true,
        chainId: 560048,
        page: Number(q.get("page")),
        pageSize: 24,
        total: 25,
        data: [
          {
            standard: q.get("standard") || "ERC-721",
            collectionAddress:
              q.get("collectionAddress") ||
              "0x1000000000000000000000000000000000000001",
            tokenId: q.get("tokenId") || "7",
            transactionHash: "0x" + "1".repeat(64),
            blockNumber: 100,
            observedAt: "2026-10-15T20:00:00Z",
          },
        ],
      },
    });
  });
  await page.goto("/create/rwa");
  const catalog = page.locator("section.minted-catalog");
  await expect(
    catalog.getByRole("link", { name: "Verify receipt ↗" }),
  ).toBeVisible();
  await catalog.getByLabel("Token standard").selectOption("ERC-1155");
  await catalog.getByLabel("Token ID", { exact: true }).fill("0");
  await catalog.getByLabel("Mint order").selectOption("oldest");
  await catalog.getByRole("button", { name: "Apply mint filters" }).click();
  await expect(
    catalog.getByRole("heading", { name: "Token #0", exact: true }),
  ).toBeVisible();
  await catalog.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    catalog.getByText("Page 2 of 2 · 25 matching mint records", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.at(-1)?.get("standard")).toBe("ERC-1155");
  expect(requests.at(-1)?.get("tokenId")).toBe("0");
  expect(requests.at(-1)?.get("sort")).toBe("oldest");
  await catalog.getByRole("button", { name: "Clear mint filters" }).click();
  await expect(
    catalog.getByText("Page 1 of 2 · 25 matching mint records", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.at(-1)?.has("tokenId")).toBe(false);
  expect(requests.at(-1)?.get("sort")).toBe("newest");
});
test("invalid mint query does not fetch, and a failed refresh hides former records", async ({
  page,
}) => {
  let requests = 0,
    fail = false;
  await page.route("**/v1/nfts?**", async (route) => {
    requests++;
    if (fail) {
      await route.fulfill({ status: 503, json: { detail: "unavailable" } });
      return;
    }
    await route.fulfill({
      json: {
        runtime: true,
        chainId: 560048,
        page: 1,
        pageSize: 24,
        total: 1,
        data: [
          {
            standard: "ERC-721",
            collectionAddress: "0x1000000000000000000000000000000000000001",
            tokenId: "7",
            transactionHash: "0x" + "1".repeat(64),
            blockNumber: 100,
            observedAt: "2026-10-15T20:00:00Z",
          },
        ],
      },
    });
  });
  await page.goto("/create/rwa");
  const catalog = page.locator("section.minted-catalog");
  await expect(
    catalog.getByRole("heading", { name: "Token #7", exact: true }),
  ).toBeVisible();
  const before = requests;
  await catalog.getByLabel("Token ID", { exact: true }).fill("01");
  await catalog.getByRole("button", { name: "Apply mint filters" }).click();
  await expect(catalog.getByRole("alert")).toContainText("canonical decimal");
  expect(requests).toBe(before);
  await catalog.getByLabel("Token ID", { exact: true }).fill("");
  fail = true;
  await catalog.getByRole("button", { name: "Refresh mint index" }).click();
  await expect(
    catalog.getByText(/The canonical mint index could not be read/),
  ).toBeVisible();
  await expect(
    catalog.getByRole("heading", { name: "Token #7", exact: true }),
  ).toHaveCount(0);
});
