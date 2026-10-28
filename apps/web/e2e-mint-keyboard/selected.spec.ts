import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://mint-fixture.invalid";
async function open(page: Page, initial = "erc721") {
  const root = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(root)
      .filter((n) => /^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(n))
      .map((n) => ["/" + n, readFileSync(join(root, n), "utf8")]),
  );
  const errors: string[] = [],
    unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin && modules.has(u.pathname))
      return route.fulfill({
        contentType: u.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: modules.get(u.pathname)!,
      });
    if (u.origin === origin && u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    unexpected.push(u.href);
    return route.abort();
  });
  await page.goto(origin + "/?standard=" + initial);
  await expect(
    page.getByRole("tablist", { name: "NFT standard" }),
  ).toBeVisible();
  return async () => {
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(await page.evaluate(() => window.mintCalls)).toEqual({
      sign: 0,
      write: 0,
    });
  };
}
const tab = (page: Page, standard: string) =>
  page.locator("#mint-tab-" + standard);
async function selected(page: Page, standard: string) {
  await expect(tab(page, standard)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute(
    "id",
    "mint-panel-" + standard,
  );
}
test("keyboard regression: arrows move focus without switching the mounted form", async ({
  page,
}) => {
  const done = await open(page);
  await tab(page, "erc721").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "erc1155")).toBeFocused();
  await selected(page, "erc721");
  await expect(page.getByLabel("Work title", { exact: true })).toBeVisible();
  await done();
});
test("Home End and left-right wrapping use a single roving tab stop", async ({
  page,
}) => {
  const done = await open(page);
  await tab(page, "erc721").focus();
  for (const [key, id] of [
    ["ArrowLeft", "erc1155"],
    ["ArrowRight", "erc721"],
    ["End", "erc1155"],
    ["ArrowRight", "erc721"],
    ["End", "erc1155"],
    ["Home", "erc721"],
  ]) {
    await page.keyboard.press(key);
    await expect(tab(page, id)).toBeFocused();
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  }
  await selected(page, "erc721");
  await done();
});
test("native Enter and Space activate the actual corresponding form", async ({
  page,
}) => {
  const done = await open(page);
  await tab(page, "erc721").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await selected(page, "erc1155");
  await expect(
    page.getByLabel("Artwork ID commitment (bytes32)", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await selected(page, "erc1155");
  await page.keyboard.press("Space");
  await selected(page, "erc721");
  await expect(page.getByLabel("Work title", { exact: true })).toBeVisible();
  await done();
});
test("initial ERC1155 and Tab expose the labelled panel to keyboard users", async ({
  page,
}) => {
  const done = await open(page, "erc1155");
  await selected(page, "erc1155");
  await tab(page, "erc1155").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tabpanel")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(tab(page, "erc1155")).toBeFocused();
  await expect(page.locator("#mint-panel-erc721")).toHaveAttribute(
    "hidden",
    "",
  );
  await done();
});
test("inactive panels retain valid ARIA ids and mount no inactive forms", async ({
  page,
}) => {
  const done = await open(page);
  for (const standard of ["erc721", "erc1155"]) {
    await expect(tab(page, standard)).toHaveAttribute(
      "aria-controls",
      "mint-panel-" + standard,
    );
    await expect(page.locator("#mint-panel-" + standard)).toHaveAttribute(
      "aria-labelledby",
      "mint-tab-" + standard,
    );
  }
  await expect(page.locator("#mint-panel-erc1155 form")).toHaveCount(0);
  await tab(page, "erc1155").click();
  await expect(page.locator("#mint-panel-erc721 form")).toHaveCount(0);
  await selected(page, "erc1155");
  await done();
});
test("unrelated keys retain focus and selected standard", async ({ page }) => {
  const done = await open(page);
  await tab(page, "erc721").focus();
  for (const key of ["ArrowUp", "ArrowDown", "Escape", "a"]) {
    await page.keyboard.press(key);
    await expect(tab(page, "erc721")).toBeFocused();
    await selected(page, "erc721");
  }
  await done();
});
test("pointer switching preserves rights notices and blocks disconnected minting", async ({
  page,
}, info) => {
  const done = await open(page);
  await expect(
    page.getByRole("button", { name: /mint.*Hoodi/i }).first(),
  ).toBeDisabled();
  await tab(page, "erc1155").click();
  await expect(
    page.getByRole("button", {
      name: "Review and mint ERC-1155 on Hoodi",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "This path does not itself create DAO rights or an ArtFi marketplace listing.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Mint and route lifecycle" })
      .getByRole("listitem"),
  ).toHaveCount(4);
  await page.screenshot({
    path: info.outputPath("mint-" + info.project.name + ".png"),
    fullPage: true,
  });
  await tab(page, "erc721").click();
  await selected(page, "erc721");
  await done();
});
