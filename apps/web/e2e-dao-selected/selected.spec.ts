import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {} from "./fixtures/main";
async function open(page: Page, queued = false) {
  const bundle = readFileSync(process.env.ARTFI_DAO_FIXTURE!, "utf8");
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://dao-fixture.invalid") return route.abort();
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: bundle,
      });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>',
    });
  });
  await page.goto("https://dao-fixture.invalid/" + (queued ? "?queued=1" : ""));
  await expect(
    page.getByRole("button", { name: "Check transaction confirmation" }),
  ).toBeVisible();
  const id = await page.evaluate(() =>
    window.daoFixture.fixture.proposal.proposalId.toString(),
  );
  return id;
}
async function ready(page: Page) {
  await page
    .getByRole("button", { name: "Check transaction confirmation" })
    .click();
  await page.getByRole("button", { name: "Verify wallet control" }).click();
  await expect(
    page.getByText("Address control verified for this browser session.", {
      exact: false,
    }),
  ).toBeVisible();
}
const queue = (page: Page) =>
  page.getByRole("button", { name: "Queue succeeded proposal", exact: true });
const execute = (page: Page) =>
  page.getByRole("button", { name: "Execute after timelock", exact: true });
async function writes(page: Page) {
  return page.evaluate(() => window.daoFixture.fixture.writes.length);
}
test("a changed inspected ID cannot queue the saved package; reselection submits its exact reviewed terms", async ({
  page,
}) => {
  const id = await open(page);
  await expect(queue(page)).toBeDisabled(); // Restored creation is UNKNOWN, even though a package exists.
  await ready(page);
  await expect(queue(page)).toBeEnabled();
  await page.getByLabel("Proposal ID", { exact: true }).fill("1");
  await expect(queue(page)).toBeDisabled();
  await expect(execute(page)).toBeDisabled();
  await expect(
    page.getByText("This saved package does not match", { exact: false }),
  ).toBeVisible();
  expect(await writes(page)).toBe(0);
  await page
    .getByRole("button", { name: "Select saved proposal", exact: true })
    .click();
  await expect(page.getByLabel("Proposal ID", { exact: true })).toHaveValue(id);
  await queue(page).click();
  await expect.poll(() => writes(page)).toBe(1);
  const sent = await page.evaluate(() => {
    const f = window.daoFixture.fixture,
      w = f.writes[0];
    return {
      method: w.functionName,
      account: w.account,
      chainId: w.chainId,
      exactArgs:
        JSON.stringify(w.args, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ) ===
        JSON.stringify(
          [
            f.proposal.targets,
            f.proposal.values,
            f.proposal.calldatas,
            f.proposal.descriptionHash,
          ],
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      simulated: f.calls.filter((x) => x.method === "simulateContract").length,
    };
  });
  expect(sent).toMatchObject({
    method: "queue",
    chainId: 560048,
    exactArgs: true,
    simulated: 1,
  });
  await expect(
    page.getByText("Proposal queued in the Timelock.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "load its published execution terms" }),
  ).toHaveAttribute("href", "/dao/proposals/execute");
});
test("a current holder read refuses transferred-away membership despite stale displayed membership", async ({
  page,
}) => {
  await open(page);
  await ready(page);
  await page.evaluate(() => {
    window.daoFixture.fixture.controls.balance = 0n;
  });
  await queue(page).click();
  await expect(
    page.getByText("Current corresponding holder membership is required.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await writes(page)).toBe(0);
});
test("simulation refusal retains the saved proposal without opening a wallet request", async ({
  page,
}) => {
  await open(page);
  await ready(page);
  await page.evaluate(() => {
    window.daoFixture.fixture.controls.failSimulation = true;
  });
  await queue(page).click();
  await expect(
    page.getByText("TEST_ONLY contract simulation reverted", { exact: true }),
  ).toBeVisible();
  expect(await writes(page)).toBe(0);
  await expect(queue(page)).toBeEnabled();
});
test("changing the selection during simulation retires the old preflight before any wallet request", async ({
  page,
}) => {
  await open(page);
  await ready(page);
  await page.evaluate(() => window.daoFixture.hold());
  await queue(page).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.daoFixture.fixture.calls.some(
          (x) => x.method === "simulateContract",
        ),
      ),
    )
    .toBe(true);
  await page.getByLabel("Proposal ID", { exact: true }).fill("1");
  await page.evaluate(() => window.daoFixture.release());
  await expect(
    page.getByText(
      "The selected proposal or wallet context changed. Review it again.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await writes(page)).toBe(0);
});
test("switching wallets during simulation cannot forward the old account's prepared request", async ({
  page,
}) => {
  await open(page);
  await ready(page);
  await page.evaluate(() => window.daoFixture.hold());
  await queue(page).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.daoFixture.fixture.calls.some(
          (x) => x.method === "simulateContract",
        ),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "TEST_ONLY switch wallet", exact: true })
    .click();
  await expect(queue(page)).toHaveCount(0);
  await page.evaluate(() => window.daoFixture.release());
  await expect
    .poll(() => page.evaluate(() => window.daoFixture.originalBusy()))
    .toBe(false);
  expect(await writes(page)).toBe(0);
});
test("an UNKNOWN queue result stays blocked until its original hash is reconciled", async ({
  page,
}) => {
  await open(page);
  await ready(page);
  await page.evaluate(() => {
    window.daoFixture.fixture.controls.unknownWrite = true;
  });
  await queue(page).click();
  await expect(
    page.getByText("confirmation unavailable", { exact: false }),
  ).toBeVisible();
  await expect(queue(page)).toBeDisabled();
  expect(await writes(page)).toBe(1);
  await page.getByLabel("Proposal ID", { exact: true }).fill("1");
  await expect(
    page.getByRole("button", { name: "Select saved proposal" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.daoFixture.fixture.controls.unknownWrite = false;
  });
  await page
    .getByRole("button", { name: "Check transaction confirmation" })
    .click();
  await expect(
    page.getByText("Proposal queued in the Timelock.", { exact: true }),
  ).toBeVisible();
  expect(await writes(page)).toBe(1);
});
test("a queued, elapsed proposal uses execution rather than queue and retains its exact package", async ({
  page,
}) => {
  await open(page, true);
  await ready(page);
  await expect(queue(page)).toBeDisabled();
  await expect(execute(page)).toBeEnabled();
  await execute(page).click();
  await expect.poll(() => writes(page)).toBe(1);
  expect(
    await page.evaluate(() => window.daoFixture.fixture.writes[0].functionName),
  ).toBe("execute");
  await expect(
    page.getByText("Timelock execution confirmed.", { exact: true }),
  ).toBeVisible();
});
