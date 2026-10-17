import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { isolatedSourceCatalog } from "../e2e-market/rwa-catalog-fixture";
import type {} from "./fixtures/main";

async function open(page: Page) {
  const bundle = readFileSync(process.env.ARTFI_AUCTION_BID_FIXTURE!, "utf8");
  const css = readFileSync(
    process.env.ARTFI_AUCTION_BID_FIXTURE!.replace(/\.js$/, ".css"),
    "utf8",
  );
  let gate: Promise<void> | undefined,
    release: (() => void) | undefined,
    held = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://auction-bid-fixture.invalid")
      return route.abort();
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: bundle,
      });
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    if (url.pathname === "/fixture.css")
      return route.fulfill({
        contentType: "text/css; charset=utf-8",
        body: css,
      });
    if (url.pathname !== "/") return route.abort();
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
    });
  });
  await isolatedSourceCatalog(page);
  await page.route("**/api/user/auth/*", async (route) => {
    if (gate) {
      const pending = gate;
      gate = undefined;
      held++;
      await pending;
    }
    return route.fulfill({
      json: {
        session: {
          id: "TEST_ONLY-auction-session",
          address: "0x1000000000000000000000000000000000000010",
          chainId: 560048,
          expiresAt: 4000000000000,
          accessExpiresAt: 4000000000000,
        },
      },
    });
  });
  await page.goto("https://auction-bid-fixture.invalid/");
  await expect(
    page.getByText("Connect and sign in on Hoodi", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Load auction", exact: true }).click();
  await expect(bid(page)).toBeEnabled();
  return {
    holdAuth() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    held: () => held,
    releaseAuth: () => release?.(),
  };
}
const bid = (page: Page) =>
  page.getByRole("button", { name: "Review and place bid", exact: true });
const methods = (page: Page) =>
  page.evaluate(() =>
    window.auctionBidFixture.state.writes.map((x) => String(x.functionName)),
  );
const changed = (page: Page) =>
  expect(
    page.getByText("Auction terms or bids changed.", { exact: false }),
  ).toBeVisible();

test("an auction changed during the real session check cannot open approval", async ({
  page,
}) => {
  const controls = await open(page);
  controls.holdAuth();
  await bid(page).click();
  await expect.poll(controls.held).toBe(1);
  expect(await methods(page)).toEqual([]);
  await page.evaluate(() => {
    window.auctionBidFixture.state.ends = 1400;
  });
  controls.releaseAuth();
  await changed(page);
  expect(await methods(page)).toEqual([]);
  await expect(bid(page)).toBeEnabled();
});
test("a confirmed approval cannot carry old auction terms into the bid", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.auctionBidFixture.state.approvalChange = true;
  });
  await bid(page).click();
  await changed(page);
  expect(await methods(page)).toEqual(["approve"]);
  expect(
    await page.evaluate(
      () => window.auctionBidFixture.state.receiptReads.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((k) =>
          k.startsWith("artfi:pending:"),
        ).length,
    ),
  ).toBe(0);
});
test("a changed auction while simulation waits cannot be forwarded", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const f = window.auctionBidFixture;
    f.state.allowance = 1000n;
    f.holdSimulation();
  });
  await bid(page).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.auctionBidFixture.state.simulationEntered),
    )
    .toBe(true);
  expect(await methods(page)).toEqual([]);
  await page.evaluate(() => {
    const f = window.auctionBidFixture;
    f.state.ends = 1400;
    f.releaseSimulation();
  });
  await changed(page);
  expect(await methods(page)).toEqual([]);
});
test("an UNKNOWN approval stays journaled and never requests a bid", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    window.auctionBidFixture.state.unknownApproval = true;
  });
  await bid(page).click();
  await expect(
    page.getByRole("button", { name: "Check transaction", exact: true }),
  ).toBeVisible();
  expect(await methods(page)).toEqual(["approve"]);
  await expect(bid(page)).toBeDisabled();
  const saved = await page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("artfi:pending:"))
      .map((k) => JSON.parse(sessionStorage.getItem(k)!)),
  );
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    kind: "approval",
    hash: `0x${"1".padStart(64, "0")}`,
  });
});
test("unchanged terms forward only the exact approved token amount and bid", async ({
  page,
}) => {
  await open(page);
  await bid(page).click();
  await expect(
    page.getByText("Bid transaction confirmed.", { exact: false }),
  ).toBeVisible();
  expect(await methods(page)).toEqual(["approve", "placeBid"]);
  const sent = await page.evaluate(() =>
    window.auctionBidFixture.state.writes.map((x) => ({
      method: x.functionName,
      to: x.address,
      account: x.account,
      chainId: x.chainId,
      args: (x.args as unknown[]).map(String),
    })),
  );
  expect(sent).toEqual([
    {
      method: "approve",
      to: "0x1000000000000000000000000000000000000005",
      account: "0x1000000000000000000000000000000000000010",
      chainId: 560048,
      args: ["0x1000000000000000000000000000000000000003", "100"],
    },
    {
      method: "placeBid",
      to: "0x1000000000000000000000000000000000000003",
      account: "0x1000000000000000000000000000000000000010",
      chainId: 560048,
      args: ["1", "100"],
    },
  ]);
});
test("wallet departure during simulation retires the old bid callback", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const f = window.auctionBidFixture;
    f.state.allowance = 1000n;
    f.holdSimulation();
  });
  await bid(page).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.auctionBidFixture.state.simulationEntered),
    )
    .toBe(true);
  await page.evaluate(() => window.auctionBidFixture.switchWallet());
  await expect(
    page.getByText("Connect and sign in on Hoodi", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => window.auctionBidFixture.releaseSimulation());
  await expect
    .poll(() =>
      page.evaluate(
        () => window.auctionBidFixture.state.postSimulationFinalChain,
      ),
    )
    .toBe(true);
  // The restored screen has no inspected auction, and the old callback is retired.
  await expect(bid(page)).toHaveCount(0);
  expect(await methods(page)).toEqual([]);
});
