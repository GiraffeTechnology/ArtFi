import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://charity-create-fixture.invalid";
const submit = (page: Page) =>
  page.getByRole("button", {
    name: "Review and mint ERC-1155 on Hoodi",
    exact: true,
  });
const check = (page: Page) =>
  page.getByRole("button", {
    name: "Check original series transaction",
    exact: true,
  });
async function open(page: Page) {
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
  await page.goto(origin);
  await expect(submit(page)).toBeEnabled();
  return async () => {
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  };
}
async function fill(page: Page) {
  await page
    .getByLabel("Artwork ID commitment (bytes32)", { exact: true })
    .fill("0x" + "1".repeat(64));
  await page
    .getByLabel("Private master SHA-256 commitment (bytes32)", { exact: true })
    .fill("0x" + "2".repeat(64));
  await page
    .getByLabel("Public metadata SHA-256 commitment (bytes32)", { exact: true })
    .fill("0x" + "3".repeat(64));
  await page
    .getByLabel("No-preview metadata URI", { exact: true })
    .fill("ipfs://TEST_ONLY/no-preview.json");
  await page.locator('[name="packageApproved"]').check();
}
async function count(page: Page) {
  return page.evaluate(() => window.charityFixture.writes.length);
}
async function journal(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) =>
      k.startsWith("artfi:setup:charity-series:"),
    );
    return key ? JSON.parse(sessionStorage.getItem(key)!) : undefined;
  });
}
test("regression: unknown receipt keeps original request blocked instead of offering another mint", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "pending"));
  await submit(page).click();
  await expect.poll(() => count(page)).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Action needs attention", exact: true }),
  ).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  await expect(check(page)).toBeEnabled();
  await done();
});
test("regression: refresh does not cancel a hashless wallet request", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "hashless"));
  await submit(page).click();
  await expect.poll(() => count(page)).toBe(1);
  await page.reload();
  await expect(submit(page)).toBeDisabled();
  await expect(check(page)).toBeEnabled();
  await expect(
    page.getByRole("heading", {
      name: "Waiting for wallet confirmation",
      exact: true,
    }),
  ).toBeVisible();
  expect((await journal(page)).pending.hash).toBeUndefined();
  await done();
});
test("fixed100 event and receipt-block balance produce exact wallet import details", async ({
  page,
}, info) => {
  const done = await open(page);
  await fill(page);
  await submit(page).click();
  await expect(
    page.getByRole("heading", {
      name: "ERC-1155 series confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect(await count(page)).toBe(1);
  expect((await journal(page)).pending).toBeUndefined();
  expect((await journal(page)).data.result.quantity).toBe("100");
  expect(
    await page.evaluate(() =>
      window.charityFixture.reads.map((r) => r.blockNumber),
    ),
  ).toEqual([77n, 77n]);
  await expect(
    page.getByRole("region", { name: "Add NFT to wallet" }),
  ).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("charity-creation.png"),
    fullPage: true,
  });
  await done();
});
test("pending broadcast survives reload and resolves read-only without a resend", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "pending"));
  await submit(page).click();
  await expect(check(page)).toBeEnabled();
  await page.reload();
  await expect(submit(page)).toBeDisabled();
  await expect(
    page.getByRole("heading", {
      name: "Waiting for Hoodi confirmation",
      exact: true,
    }),
  ).toBeVisible();
  await check(page).click();
  await expect(
    page.getByRole("heading", {
      name: "ERC-1155 series confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect(await count(page)).toBe(0);
  await done();
});
test("wallet rejection permits only a deliberate subsequent retry", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "reject"));
  await submit(page).click();
  await expect(submit(page)).toBeEnabled();
  expect((await journal(page)).pending).toBeUndefined();
  await page.evaluate(() => (window.charityFixture.mode = "success"));
  await submit(page).click();
  await expect(
    page.getByRole("heading", {
      name: "ERC-1155 series confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect(await count(page)).toBe(2);
  await done();
});
for (const mode of ["revert", "wrong-hash"]) {
  test(
    "receipt outcome " + mode + " never becomes confirmed",
    async ({ page }) => {
      const done = await open(page);
      await fill(page);
      await page.evaluate((mode) => (window.charityFixture.mode = mode), mode);
      await submit(page).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "ERC-1155 series confirmed",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(Boolean((await journal(page)).pending)).toBe(mode !== "revert");
      expect(await count(page)).toBe(1);
      await done();
    },
  );
}
for (const field of ["supply", "balance"] as const) {
  test(
    "non100 " + field + " remains pending for reconciliation",
    async ({ page }) => {
      const done = await open(page);
      await fill(page);
      await page.evaluate(
        (field) => (window.charityFixture[field] = 99n),
        field,
      );
      await submit(page).click();
      await expect(page.getByRole("alert")).toContainText("100 units");
      await expect(submit(page)).toBeDisabled();
      expect((await journal(page)).pending.hash).toBeTruthy();
      await done();
    },
  );
}
test("mismatched event cannot clear the original pending transaction", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.eventMismatch = true));
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText("missing or mismatched");
  await expect(submit(page)).toBeDisabled();
  await done();
});
test("canonical block changes after reads remain unresolved", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.reorg = true));
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText("block or chain changed");
  await expect(submit(page)).toBeDisabled();
  await done();
});
test("late hash after wallet disconnect is retained in its original journal", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "hashless"));
  await submit(page).click();
  await expect.poll(() => count(page)).toBe(1);
  await page.evaluate(() => window.charityFixture.setWallet(560048, false));
  await page.evaluate(() => window.charityFixture.releaseWallet());
  await expect
    .poll(async () => Boolean((await journal(page)).pending?.hash))
    .toBe(true);
  await expect(submit(page)).toBeDisabled();
  expect(await count(page)).toBe(1);
  await done();
});
test("late simulation after chain change cannot invoke a wallet", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(
    () => (window.charityFixture.mode = "simulation-pending"),
  );
  await submit(page).click();
  await expect
    .poll(() => page.evaluate(() => window.charityFixture.simulations.length))
    .toBe(1);
  await page.evaluate(() => window.charityFixture.setWallet(1));
  await page.evaluate(() => window.charityFixture.releaseSimulation());
  await expect(submit(page)).toBeDisabled();
  expect(await count(page)).toBe(0);
  await done();
});
test("saved receipt is labelled unverified on reload until a fresh check", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await submit(page).click();
  await expect(
    page.getByRole("heading", {
      name: "ERC-1155 series confirmed",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Saved series receipt — recheck its confirmation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Add NFT to wallet" }),
  ).toHaveCount(0);
  await check(page).click();
  await expect(
    page.getByRole("region", { name: "Add NFT to wallet" }),
  ).toBeVisible();
  expect(await count(page)).toBe(0);
  await done();
});

test("repriced original creation reconciles the canonical replacement once", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "repriced"));
  await submit(page).click();
  await expect(
    page.getByRole("heading", {
      name: "ERC-1155 series confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect((await journal(page)).data.result.transactionHash).toBe(
    "0x" + "c".repeat(64),
  );
  expect((await journal(page)).pending).toBeUndefined();
  expect(await count(page)).toBe(1);
  await done();
});
test("canonical cancellation retains its proof without claiming NFT completion", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityFixture.mode = "cancelled"));
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "confirmed canonical block",
  );
  expect((await journal(page)).pending).toBeUndefined();
  expect((await journal(page)).data.lastFailure.outcome).toBe("replaced");
  expect((await journal(page)).data.lastFailure.receiptHash).toBe(
    "0x" + "c".repeat(64),
  );
  await expect(
    page.getByRole("region", { name: "Add NFT to wallet" }),
  ).toHaveCount(0);
  await expect(submit(page)).toBeEnabled();
  expect(await count(page)).toBe(1);
  await done();
});
test("noncanonical reverted receipt cannot release the original request", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => {
    window.charityFixture.mode = "revert";
    window.charityFixture.readerChain = 1;
  });
  await submit(page).click();
  await expect(page.getByRole("alert")).toContainText("block or chain changed");
  expect((await journal(page)).pending.hash).toBe("0x" + "a".repeat(64));
  expect((await journal(page)).data.lastFailure).toBeUndefined();
  await expect(submit(page)).toBeDisabled();
  expect(await count(page)).toBe(1);
  await done();
});
