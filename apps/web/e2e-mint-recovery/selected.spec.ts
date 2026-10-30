import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://mint-recovery-fixture.invalid";
const check = (page: Page) =>
  page.getByRole("button", { name: "Check mint transaction", exact: true });
async function saved(page: Page) {
  return page.evaluate(() => {
    const keys = Object.keys(sessionStorage).filter((k) =>
      k.startsWith("artfi:setup:mint:"),
    );
    if (keys.length !== 1) throw Error("Unexpected recovery membership");
    return JSON.parse(sessionStorage.getItem(keys[0])!);
  });
}
async function open(page: Page, mode = "normal") {
  const root = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(root)
      .filter((n) => /^[a-zA-Z0-9_.-]+\.(js|css)$/.test(n))
      .map((n) => ["/" + n, readFileSync(join(root, n), "utf8")]),
  );
  const errors: string[] = [],
    unexpected: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) {
      unexpected.push(u.href);
      return route.abort();
    }
    if (modules.has(u.pathname))
      return route.fulfill({
        contentType: u.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: modules.get(u.pathname)!,
      });
    if (u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (u.pathname === "/api/operator/auth/session")
      return route.fulfill({ json: { authenticated: false } });
    if (u.pathname === "/api/operator/v1/rwa/intents/intent-test")
      return route.fulfill({
        status: 503,
        json: { error: "TEST_ONLY intent lookup unavailable" },
      });
    unexpected.push(u.pathname);
    return route.abort();
  });
  await page.goto(origin + "/?mode=" + mode);
  await expect(check(page)).toBeEnabled();
  return {
    async clean() {
      expect(
        await page.evaluate(() => ({
          sign: window.mintRecoveryFixture.sign,
          write: window.mintRecoveryFixture.write,
        })),
      ).toEqual({ sign: 0, write: 0 });
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    },
  };
}
test("native mint recovery resolves the original request without a transaction hash or functioning intent API", async ({
  page,
}, info) => {
  const c = await open(page);
  await check(page).click();
  await expect(
    page.getByRole("heading", { name: "Mint confirmed on Hoodi", exact: true }),
  ).toBeVisible();
  expect((await saved(page)).pending).toBeUndefined();
  expect((await saved(page)).data.minted).toMatchObject({
    chainId: 560048,
    collectionAddress: "0x1000000000000000000000000000000000000002",
    tokenId: "7",
  });
  expect(await page.evaluate(() => window.mintRecoveryFixture.reads)).toEqual([
    { method: "assetByRequest", block: "100" },
    { method: "nft", block: "100" },
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: info.outputPath("mint-recovered.png"),
    fullPage: true,
  });
  await c.clean();
});
for (const mode of [
  "wrong-chain",
  "chain-flip",
  "reorg",
  "unmined",
  "zero-hash",
  "unavailable",
])
  test(`native mint recovery: ${mode} preserves the exact pending request and permits only fresh readonly reconciliation`, async ({
    page,
  }) => {
    const c = await open(page, mode);
    const before = await saved(page);
    await check(page).click();
    await expect(
      page.getByRole("heading", {
        name: "Action needs attention",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Mint confirmed on Hoodi",
        exact: true,
      }),
    ).toHaveCount(0);
    const after = await saved(page);
    expect(after.pending).toEqual(before.pending);
    expect(after.data.intent).toEqual(before.data.intent);
    expect(after.data.minted).toBeUndefined();
    await expect(check(page)).toBeEnabled();
    await page.evaluate(() => {
      window.mintRecoveryFixture.mode = "normal";
      window.mintRecoveryFixture.blocks = 0;
    });
    await check(page).click();
    await expect(
      page.getByRole("heading", {
        name: "Mint confirmed on Hoodi",
        exact: true,
      }),
    ).toBeVisible();
    await c.clean();
  });
test("native mint recovery: reload preserves the same pending operation without requesting another mint", async ({
  page,
}) => {
  const c = await open(page, "wrong-chain");
  const before = await saved(page);
  await check(page).click();
  await expect(
    page.getByRole("heading", { name: "Action needs attention", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(check(page)).toBeEnabled();
  expect((await saved(page)).pending).toEqual(before.pending);
  await page.evaluate(() => {
    window.mintRecoveryFixture.mode = "normal";
  });
  await check(page).click();
  await expect(
    page.getByRole("heading", { name: "Mint confirmed on Hoodi", exact: true }),
  ).toBeVisible();
  await c.clean();
});
