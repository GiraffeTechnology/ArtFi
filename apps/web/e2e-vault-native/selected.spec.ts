import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://vault-fixture.invalid";
const approve = (page: Page) =>
  page.getByRole("button", {
    name: "Step 2 · Approve this token only",
    exact: true,
  });
const deposit = (page: Page) =>
  page.getByRole("button", {
    name: "Step 3 · Deposit into Vault",
    exact: true,
  });
const issue = (page: Page) =>
  page.getByRole("button", {
    name: "Step 4 · Issue fixed fractions",
    exact: true,
  });
const journal = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(
      sessionStorage.getItem(
        `artfi:setup:vault:560048:${window.vaultAddresses.owner}`,
      )!,
    ),
  );
async function open(
  page: Page,
  query = "stage=created",
  grounded = true,
  intentTokenId = "7",
) {
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
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (u.pathname === "/api/operator/auth/session")
      return route.fulfill({
        json: {
          authenticated: true,
          address: "0x1000000000000000000000000000000000000001",
        },
      });
    if (u.pathname === "/v1/config")
      return route.fulfill({
        json: {
          chainId: 560048,
          vaultFactoryAddress: "0x1000000000000000000000000000000000000003",
        },
      });
    if (
      u.pathname === "/api/operator/v1/vault/intents" &&
      route.request().method() === "POST"
    ) {
      const value = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...value,
          intentId: "test-only-created-intent",
          requestId: `0x${"a".repeat(64)}`,
          factoryAddress: "0x1000000000000000000000000000000000000003",
          chainId: 560048,
          tokenId: intentTokenId,
        },
      });
    }
    if (
      u.pathname ===
        "/api/operator/v1/vault/intents/test-only-created-intent/submission" &&
      route.request().method() === "POST"
    )
      return route.fulfill({ json: { recorded: true } });
    if (u.pathname === "/api/rwa/underlying-status")
      return route.fulfill({
        status: grounded ? 200 : 409,
        json: {
          grounded,
          chainId: 560048,
          collectionAddress: u.searchParams.get("collectionAddress"),
          tokenId: u.searchParams.get("tokenId"),
          checkedAt: new Date().toISOString(),
        },
      });
    unexpected.push(u.pathname);
    return route.abort();
  });
  await page.goto(origin + "/?" + query);
  await expect(
    page.getByText("Reviewed Hoodi VaultFactory:", { exact: false }),
  ).toBeVisible();
  return async () => {
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(await page.evaluate(() => window.vaultFixture.signs)).toBe(0);
  };
}
test("separate exact approval, custody and issuance confirmations preserve reviewed terms", async ({
  page,
}, info) => {
  const done = await open(page);
  await expect(approve(page)).toBeEnabled();
  await approve(page).click();
  await expect(deposit(page)).toBeEnabled();
  expect((await journal(page)).data.stage).toBe("approved");
  expect(await page.evaluate(() => window.vaultFixture.calls)).toEqual(
    [
      {
        functionName: "approve",
        address: "0x1000000000000000000000000000000000000002",
        args: ["0x1000000000000000000000000000000000000004", 7n],
      },
    ].map((x) => ({
      ...x,
      args: x.args.map((v) => (typeof v === "bigint" ? v : v)),
    })),
  );
  await deposit(page).click();
  await expect(issue(page)).toBeEnabled();
  expect((await journal(page)).data.stage).toBe("deposited");
  await issue(page).click();
  await expect(
    page.getByRole("heading", {
      name: "DAO asset setup confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect((await journal(page)).data.stage).toBe("complete");
  expect((await journal(page)).pending).toBeUndefined();
  expect(
    await page.evaluate(() =>
      window.vaultFixture.calls.map((c) => c.functionName),
    ),
  ).toEqual(["approve", "deposit", "fractionalize"]);
  await page.screenshot({
    path: info.outputPath("vault-complete.png"),
    fullPage: true,
  });
  await done();
});
test("wallet rejection retains stage and allows a deliberate separate retry", async ({
  page,
}) => {
  const done = await open(page);
  await page.evaluate(() => (window.vaultFixture.mode = "reject"));
  await approve(page).click();
  await expect(approve(page)).toBeEnabled();
  expect((await journal(page)).pending).toBeUndefined();
  await page.evaluate(() => (window.vaultFixture.mode = "success"));
  await approve(page).click();
  await expect(deposit(page)).toBeEnabled();
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(2);
  await done();
});
test("unknown broadcast survives reload and reconciles without resend", async ({
  page,
}) => {
  const done = await open(page);
  await page.evaluate(() => (window.vaultFixture.mode = "receipt-pending"));
  await approve(page).click();
  await expect(
    page.getByRole("button", { name: "Check transaction", exact: true }),
  ).toBeEnabled();
  expect((await journal(page)).pending.hash).toMatch(/^0x[b]{64}$/);
  await page.reload();
  await expect(approve(page)).toBeDisabled();
  await page.evaluate(() => {
    window.vaultFixture.mode = "success";
    window.vaultFixture.stage = "approved";
  });
  await page
    .getByRole("button", { name: "Check transaction", exact: true })
    .click();
  await expect(deposit(page)).toBeEnabled();
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("unresolved hashless wallet prompt survives reload and blocks another write", async ({
  page,
}) => {
  const done = await open(page, "stage=created&unknown=1");
  await expect(approve(page)).toBeDisabled();
  expect((await journal(page)).pending.hash).toBeUndefined();
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await page.reload();
  await expect(approve(page)).toBeDisabled();
  await done();
});
test("changed owner prevents exact-token authorization", async ({ page }) => {
  const done = await open(page);
  await page.evaluate(
    () => (window.vaultFixture.ownerOverride = window.vaultAddresses.other),
  );
  await approve(page).click();
  await expect(page.getByRole("alert")).toContainText("no longer");
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("changed factory request binding prevents a prompt", async ({ page }) => {
  const done = await open(page);
  await page.evaluate(
    () => (window.vaultFixture.requestVault = window.vaultAddresses.other),
  );
  await approve(page).click();
  await expect(page.getByRole("alert")).toContainText("differs");
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("revoked underlying evidence prevents new fractions but preserves custody", async ({
  page,
}) => {
  const done = await open(page, "stage=deposited", false);
  await issue(page).click();
  await expect(page.getByRole("alert")).toContainText("approved-source");
  expect((await journal(page)).data.stage).toBe("deposited");
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("late wallet hash after disconnect stays in original journal without advancing the new screen", async ({
  page,
}) => {
  const done = await open(page);
  await page.evaluate(() => (window.vaultFixture.mode = "wallet-pending"));
  await approve(page).click();
  await expect
    .poll(() => page.evaluate(() => window.vaultFixture.calls.length))
    .toBe(1);
  await page.evaluate(() => window.vaultFixture.setWallet(560048, false));
  await page.evaluate(() => window.vaultFixture.releaseWallet());
  await expect
    .poll(async () => Boolean((await journal(page)).pending?.hash))
    .toBe(true);
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(1);
  await expect(deposit(page)).toHaveCount(0);
  await done();
});

test("initial creation completes prepare/create/approve/deposit/issuance as four separate actions", async ({
  page,
}) => {
  const done = await open(page, "stage=configure");
  const create = page.getByRole("button", {
    name: "Step 1 · Create Vault",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(approve(page)).toBeEnabled();
  const recorded = await journal(page);
  expect(recorded.data.intent.intentId).toBe("test-only-created-intent");
  expect(recorded.data.creationHash).toMatch(/^0x[b]{64}$/);
  expect(recorded.pending).toBeUndefined();
  expect(
    await page.evaluate(() =>
      window.vaultFixture.calls.map((c) => c.functionName),
    ),
  ).toEqual(["createVault"]);
  await approve(page).click();
  await expect(deposit(page)).toBeEnabled();
  await deposit(page).click();
  await expect(issue(page)).toBeEnabled();
  await issue(page).click();
  await expect(
    page.getByRole("heading", {
      name: "DAO asset setup confirmed",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.vaultFixture.calls.map((c) => c.functionName),
    ),
  ).toEqual(["createVault", "approve", "deposit", "fractionalize"]);
  await done();
});
test("initial creation requires current factory creator role", async ({
  page,
}) => {
  const done = await open(page, "stage=configure");
  await page.evaluate(() => (window.vaultFixture.roleAllowed = false));
  await page
    .getByRole("button", { name: "Step 1 · Create Vault", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("CREATOR_ROLE");
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("initial creation refuses changed on-chain NFT owner", async ({
  page,
}) => {
  const done = await open(page, "stage=configure");
  await page.evaluate(
    () => (window.vaultFixture.ownerOverride = window.vaultAddresses.other),
  );
  await page
    .getByRole("button", { name: "Step 1 · Create Vault", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("own this NFT");
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});
test("initial creation refuses a server intent for another token", async ({
  page,
}) => {
  const done = await open(page, "stage=configure", true, "8");
  await page
    .getByRole("button", { name: "Step 1 · Create Vault", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => window.vaultFixture.calls.length)).toBe(0);
  await done();
});

test("completed Vault stays within viewport and pointer controls remain touch sized", async ({
  page,
}) => {
  const done = await open(page);
  await approve(page).click();
  await expect(deposit(page)).toBeEnabled();
  await deposit(page).click();
  await expect(issue(page)).toBeEnabled();
  await issue(page).click();
  await expect(
    page.getByRole("heading", {
      name: "DAO asset setup confirmed",
      exact: true,
    }),
  ).toBeVisible();
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  const button = page.getByRole("button", {
    name: "Prepare another Vault",
    exact: true,
  });
  await button.scrollIntoViewIfNeeded();
  const bounds = await button.boundingBox();
  console.log(
    "VAULT_LAYOUT",
    JSON.stringify({ ...width, buttonHeight: bounds!.height }),
  );
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(
    await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return hit === el || el.contains(hit);
    }),
  ).toBe(true);
  await done();
});
