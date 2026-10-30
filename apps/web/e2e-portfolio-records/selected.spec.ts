import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "https://portfolio-fixture.invalid";
const address = "0x6666666666666666666666666666666666666666";
const token = "0x7777777777777777777777777777777777777777";
const payment = "0x8888888888888888888888888888888888888888";
function response() {
  const transactions = Array.from({ length: 23 }, (_, index) => {
    const transactionHash = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    return {
      id: `560048:${transactionHash}:${index}`,
      transactionHash,
      logIndex: index,
      contractAddress: token,
      eventName: index % 2 === 0 ? "IntentFilled" : "Transfer",
      blockNumber: 100 + index,
      status: index === 22 ? "removed" : index === 21 ? "pending" : "confirmed",
      observedAt: "2026-10-18T16:00:00Z",
    };
  });
  return {
    address,
    chainId: 560048,
    network: "hoodi",
    positions: [
      {
        assetToken: token,
        symbol: "TEST_ONLY",
        balance: "900719925474099300000001",
        updatedAt: "2026-10-18T16:00:00Z",
      },
    ],
    transactions,
    offers: [],
    notifications: [
      {
        ...transactions[22],
        message:
          "IntentFilled was removed from the canonical chain. Any previous confirmation no longer applies.",
      },
    ],
    performance: {
      status: "known_for_indexed_history",
      method: "fifo",
      scope: "confirmed_indexed_fraction_trades",
      unmappedTradeCount: 0,
      pendingEventCount: 1,
      reasons: [],
      items: [
        {
          assetToken: token,
          paymentToken: payment,
          confirmedQuantity: "900719925474099300000001",
          costBasis: "1801439850948198600000002",
          realizedPnl: "-1",
          status: "known",
          buyCount: 2,
          sellCount: 1,
          reasons: [],
        },
      ],
    },
  };
}
type Mode = "success" | "error" | "context" | "invalid" | "hold" | "empty";
async function open(page: Page, chain = 560048) {
  const bundle = readFileSync(process.env.ARTFI_PORTFOLIO_FIXTURE!, "utf8");
  const css = readFileSync(
    process.env.ARTFI_PORTFOLIO_FIXTURE!.replace(/fixture\.js$/, "style.css"),
    "utf8",
  );
  const state = {
    authenticated: false,
    delayedSettled: false,
    reads: 0,
    mode: "success" as Mode,
    blocked: [] as string[],
    release: undefined as (() => void) | undefined,
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      state.blocked.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/fixture.js")
      return route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: bundle,
      });
    if (url.pathname === "/style.css")
      return route.fulfill({
        contentType: "text/css; charset=utf-8",
        body: css,
      });
    if (url.pathname.startsWith("/api/user/auth/")) {
      if (url.pathname.endsWith("/logout")) state.authenticated = false;
      return route.fulfill({
        json: {
          session: state.authenticated
            ? {
                id: "TEST_ONLY-records-session",
                address,
                chainId: chain,
                expiresAt: 4000000000000,
                accessExpiresAt: 4000000000000,
              }
            : null,
        },
      });
    }
    if (url.pathname === `/api/portfolio/${address}`) {
      expect(request.method()).toBe("GET");
      state.reads += 1;
      const mode = state.mode;
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (mode === "error")
        return route.fulfill({
          status: 503,
          json: { error: "TEST_ONLY unavailable" },
        });
      const body = response();
      if (mode === "context") body.address = token;
      if (mode === "invalid")
        body.notifications[0].message = "TEST_ONLY contradictory confirmation";
      if (mode === "empty") {
        body.positions = [];
        body.transactions = [];
        body.notifications = [];
        body.performance.items = [];
        body.performance.status = "no_indexed_history";
      }
      try {
        return await route.fulfill({ json: body });
      } catch {
        return;
      } finally {
        if (mode === "hold") state.delayedSettled = true;
      }
    }
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>',
      });
    state.blocked.push(url.pathname);
    return route.abort();
  });
  await page.goto(origin + "/");
  await page
    .getByRole("button", { name: "Connect TEST_ONLY wallet", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    `connected:${chain}`,
  );
  const restore = async () => {
    state.authenticated = true;
    await page
      .getByRole("button", { name: "Restore TEST_ONLY session", exact: true })
      .click();
    await expect(page.getByTestId("real-session-state")).toHaveText(
      "authenticated",
    );
  };
  return { state, restore };
}
const records = (page: Page) => page.locator("section.portfolio-records");
const history = (page: Page) =>
  records(page)
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Transaction history",
        exact: true,
      }),
    });
const refresh = (page: Page) =>
  page.getByRole("button", {
    name: "Refresh positions, P&L and notifications",
    exact: true,
  });
async function viewport(page: Page) {
  const width = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(width.doc).toBeLessThanOrEqual(width.viewport);
}
test("unsigned records do not query holdings or expose indexed data", async ({
  page,
}) => {
  const { state } = await open(page);
  await expect(records(page)).toContainText(
    "Sign in with the connected wallet",
  );
  expect(state.reads).toBe(0);
  await expect(records(page)).not.toContainText("9007199254740993");
  expect(state.blocked).toEqual([]);
});
test("authenticated records preserve exact quantities, negative P&L and removal evidence", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  await expect(records(page)).toContainText(
    "1801439850948198600000002 payment-token base units",
  );
  await expect(records(page)).toContainText("-1 payment-token base units");
  await expect(records(page)).toContainText(payment);
  await expect(records(page)).toContainText(
    "Any previous confirmation no longer applies.",
  );
  await viewport(page);
  await page.screenshot({
    path: test.info().outputPath("indexed-records-ready.png"),
    fullPage: true,
  });
  expect(state.blocked).toEqual([]);
});
test("history pages, filters, chronological order and reset operate on loaded records", async ({
  page,
}) => {
  const { restore } = await open(page);
  await restore();
  const panel = history(page);
  await expect(panel).toContainText("Page 1 of 3");
  await expect(panel.locator("ol > li")).toHaveCount(10);
  await expect(panel.locator("ol > li").first()).toContainText("block 122");
  await panel.getByRole("button", { name: "Next history page" }).click();
  await expect(panel).toContainText("Page 2 of 3");
  await panel
    .getByLabel("History status", { exact: true })
    .selectOption("removed");
  await expect(panel).toContainText("Page 1 of 1");
  await expect(panel.locator("ol > li")).toHaveCount(1);
  await expect(panel).toContainText("previous confirmation no longer applies");
  await panel
    .getByLabel("History event", { exact: true })
    .selectOption("Transfer");
  await expect(panel).toContainText("No loaded records match");
  await panel.getByRole("button", { name: "Reset history filters" }).click();
  await panel
    .getByLabel("History order", { exact: true })
    .selectOption("oldest");
  await expect(panel.locator("ol > li").first()).toContainText("block 100");
  await viewport(page);
});
test("failed refresh hides previously loaded data and a successful retry restores it", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  state.mode = "error";
  await refresh(page).click();
  await expect(records(page).getByRole("alert")).toContainText(
    "Portfolio API returned 503",
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
  await viewport(page);
  state.mode = "success";
  await page.getByRole("button", { name: "Retry indexed records" }).click();
  await expect(records(page)).toContainText("900719925474099300000001");
  expect(state.blocked).toEqual([]);
});
test("a response for a different address is refused without rendering positions", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "context";
  await restore();
  await expect(records(page).getByRole("alert")).toContainText(
    "did not match the connected Hoodi address",
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
  await viewport(page);
});
test("contradictory notification evidence refuses the entire response", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "invalid";
  await restore();
  await expect(records(page).getByRole("alert")).toContainText(
    "API response was incomplete",
  );
  await expect(records(page)).not.toContainText(
    "TEST_ONLY contradictory confirmation",
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
});
test("a delayed response after signout cannot reveal retired private records", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "hold";
  await restore();
  await expect.poll(() => state.reads).toBe(1);
  await page
    .getByRole("button", { name: "End TEST_ONLY session", exact: true })
    .click();
  await expect(records(page)).toContainText(
    "Sign in with the connected wallet",
  );
  state.release?.();
  await expect.poll(() => state.delayedSettled).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
  await expect(records(page).locator("article")).toHaveCount(0);
  expect(state.blocked).toEqual([]);
});
test("switching away from the authenticated chain retires the loaded records", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  const reads = state.reads;
  await page
    .getByRole("button", { name: "Switch TEST_ONLY chain", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText("connected:1");
  await expect(records(page)).toContainText(
    "Sign in with the connected wallet",
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
  expect(state.reads).toBe(reads);
  expect(state.blocked).toEqual([]);
});
test("empty indexed records show absence without inventing holdings or performance", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "empty";
  await restore();
  await expect(records(page)).toContainText("No indexed token position");
  await expect(records(page)).toContainText("No indexed transaction");
  await expect(records(page)).toContainText("No indexed wallet notification");
  await expect(records(page)).toContainText(
    "No supported performance calculation",
  );
  await expect(history(page)).toContainText("Page 1 of 1");
  await viewport(page);
  expect(state.blocked).toEqual([]);
});
