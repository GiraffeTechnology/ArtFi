import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://charity-evidence-fixture.invalid",
  hash = "0x" + "4".repeat(64),
  tx = "0x" + "a".repeat(64);
const submit = (page: Page) =>
  page.getByRole("button", {
    name: "Review evidence record with wallet or Safe",
    exact: true,
  });
const check = (page: Page) =>
  page.getByRole("button", {
    name: "Check original evidence transaction",
    exact: true,
  });
const panel = (page: Page) =>
  page.getByRole("region", { name: "Charity evidence recording", exact: true });
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
  await expect(panel(page)).toBeVisible();
  return () => {
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  };
}
async function fill(page: Page, donation = false) {
  if (donation)
    await page
      .getByRole("combobox", { name: "Evidence action", exact: true })
      .selectOption("donation");
  await page
    .getByLabel("Reviewed evidence hash (bytes32)", { exact: true })
    .fill(hash);
  await panel(page).getByRole("checkbox").check();
  await expect(submit(page)).toBeEnabled();
}
async function journal(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) =>
      k.startsWith("artfi:setup:charity-evidence:"),
    );
    return key ? JSON.parse(sessionStorage.getItem(key)!) : undefined;
  });
}
async function writes(page: Page) {
  return page.evaluate(() => window.charityEvidenceFixture.writes.length);
}
test("regression: a noncanonical reverted receipt cannot release the evidence request", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(
    () => (window.charityEvidenceFixture.mode = "revert-noncanonical"),
  );
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  expect((await journal(page)).pending).toBeTruthy();
  await expect(submit(page)).toBeDisabled();
  expect(await writes(page)).toBe(1);
  done();
});
test("sellout records only its exact canonical evidence and retains public proof", async ({
  page,
}, info) => {
  const done = await open(page);
  await fill(page);
  await submit(page).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Sellout evidence recorded",
  );
  expect((await journal(page)).data.outcome).toMatchObject({
    originalHash: tx,
    transactionHash: tx,
    status: "confirmed",
    blockNumber: "77",
  });
  expect((await journal(page)).pending).toBeUndefined();
  expect(await writes(page)).toBe(1);
  await expect(page.locator("img,input[type=file]")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("charity-evidence.png"),
    fullPage: true,
  });
  done();
});
test("physical acceptance requires an already recorded sellout", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page, true);
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "Sellout must be recorded",
  );
  expect(await writes(page)).toBe(0);
  done();
});
test("physical acceptance after sellout has an exact independent evidence record", async ({
  page,
}) => {
  const done = await open(page);
  await page.evaluate(() => (window.charityEvidenceFixture.soldOut = true));
  await fill(page, true);
  await submit(page).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Physical donation acceptance evidence recorded",
  );
  expect((await journal(page)).data.action).toBe("donation");
  expect((await journal(page)).data.outcome.status).toBe("confirmed");
  done();
});
test("a nonzero distributor balance prevents a sellout wallet request", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.balance = 1n));
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("zero units");
  expect(await writes(page)).toBe(0);
  done();
});
test("unknown receipt survives refresh and resolves without a second write", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "pending"));
  await submit(page).click();
  await expect(check(page)).toBeEnabled();
  await page.reload();
  await expect(submit(page)).toBeDisabled();
  await check(page).click();
  await expect(panel(page).getByRole("status")).toContainText("is reconciled");
  expect(await writes(page)).toBe(0);
  expect((await journal(page)).data.outcome.status).toBe("confirmed");
  done();
});
test("a hashless request survives refresh and a failed supplied hash cannot release it", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "hashless"));
  await submit(page).click();
  await expect.poll(() => writes(page)).toBe(1);
  await page.reload();
  await page
    .getByLabel("Original wallet transaction hash", { exact: true })
    .fill(tx);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "revert"));
  await check(page).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  expect((await journal(page)).pending.hash).toBeUndefined();
  await expect(submit(page)).toBeDisabled();
  expect(await writes(page)).toBe(0);
  done();
});
test("canonical revert retains failure proof and permits only deliberate retry", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "revert"));
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "confirmed canonical block",
  );
  expect((await journal(page)).data.outcome.status).toBe("reverted");
  expect((await journal(page)).pending).toBeUndefined();
  await expect(submit(page)).toBeEnabled();
  expect(await writes(page)).toBe(1);
  done();
});
for (const mode of ["cancelled", "repriced"]) {
  test("original actor nonce binds " + mode + " outcome", async ({ page }) => {
    const done = await open(page);
    await fill(page);
    await page.evaluate(
      (mode) => (window.charityEvidenceFixture.mode = mode),
      mode,
    );
    await submit(page).click();
    await expect
      .poll(async () => Boolean((await journal(page)).data.outcome))
      .toBe(true);
    expect((await journal(page)).data.outcome.transactionHash).toBe(
      "0x" + "c".repeat(64),
    );
    expect((await journal(page)).data.outcome.status).toBe(
      mode === "repriced" ? "confirmed" : "replaced",
    );
    expect(await writes(page)).toBe(1);
    done();
  });
}
test("a different nonce replacement cannot unlock or replace the original journal hash", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(
    () => (window.charityEvidenceFixture.mode = "wrong-nonce"),
  );
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("actor and nonce");
  expect((await journal(page)).pending.hash).toBe(tx);
  expect((await journal(page)).data.outcome).toBeUndefined();
  await expect(submit(page)).toBeDisabled();
  done();
});
test("mismatched evidence event remains unknown", async ({ page }) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(
    () => (window.charityEvidenceFixture.mode = "event-mismatch"),
  );
  await submit(page).click();
  await expect(panel(page).getByRole("alert")).toBeVisible();
  expect((await journal(page)).pending.hash).toBe(tx);
  await expect(submit(page)).toBeDisabled();
  done();
});
test("wallet rejection leaves no pending request and requires a deliberate retry", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "reject"));
  await submit(page).click();
  await expect(submit(page)).toBeEnabled();
  expect((await journal(page)).pending).toBeUndefined();
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "success"));
  await submit(page).click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Sellout evidence recorded",
  );
  expect(await writes(page)).toBe(2);
  done();
});
test("late wallet hash after disconnect remains in the original request journal", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(() => (window.charityEvidenceFixture.mode = "hashless"));
  await submit(page).click();
  await expect.poll(() => writes(page)).toBe(1);
  await page.evaluate(() =>
    window.charityEvidenceFixture.setWallet(560048, false),
  );
  await page.evaluate(() => window.charityEvidenceFixture.releaseWallet());
  await expect
    .poll(async () => Boolean((await journal(page)).pending.hash))
    .toBe(true);
  await expect(submit(page)).toBeDisabled();
  done();
});
test("retired preflight cannot open a wallet request after chain change", async ({
  page,
}) => {
  const done = await open(page);
  await fill(page);
  await page.evaluate(
    () => (window.charityEvidenceFixture.mode = "simulation-pending"),
  );
  await submit(page).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.charityEvidenceFixture.simulations.length),
    )
    .toBe(1);
  await page.evaluate(() => window.charityEvidenceFixture.setWallet(1));
  await page.evaluate(() => window.charityEvidenceFixture.releaseSimulation());
  await expect(submit(page)).toBeDisabled();
  expect(await writes(page)).toBe(0);
  done();
});
