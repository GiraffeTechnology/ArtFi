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
    logouts: 0,
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
      if (url.pathname.endsWith("/logout")) {
        state.authenticated = false;
        state.logouts += 1;
      }
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
      // Mirror the actual BFF requireUserSession(address) default Hoodi check.
      if (chain !== 560048)
        return route.fulfill({
          status: 403,
          json: { error: "Sign in with the seller wallet." },
        });
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
  await page.goto(origin + "/?network=" + chain);
  await page
    .getByRole("button", { name: "Connect TEST_ONLY wallet", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    `connected:${chain}`,
  );
  const restore = async () => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByTestId("real-session-retirement")).toHaveText(
      "settled",
    );
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

for (const chain of [1, 8453]) {
  test(`matching non-Hoodi session ${chain} shows explicit support boundary without a portfolio request`, async ({
    page,
  }) => {
    const { state, restore } = await open(page, chain);
    await restore();
    await expect(records(page).getByRole("status")).toContainText(
      "available on Hoodi only",
      { timeout: 1200 },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(state.reads).toBe(0);
    await expect(records(page).locator("article")).toHaveCount(0);
    await expect(records(page)).not.toContainText("900719925474099300000001");
    await viewport(page);
    expect(state.blocked).toEqual([]);
  });
}
test("Hoodi authenticated session still loads the exact indexed records", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  await expect(records(page)).toContainText("Indexed Hoodi records");
  expect(state.reads).toBe(1);
  await viewport(page);
  expect(state.blocked).toEqual([]);
});
test("switching to Base retires Hoodi records and return requires a fresh read", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  await page
    .getByRole("button", { name: "Switch TEST_ONLY Base", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    "connected:8453",
  );
  await expect(records(page)).toContainText(
    "Sign in with the connected wallet",
  );
  await expect(records(page)).not.toContainText("900719925474099300000001");
  expect(state.reads).toBe(1);
  await expect.poll(() => state.logouts).toBe(1);
  await page
    .getByRole("button", { name: "Switch TEST_ONLY Hoodi", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    "connected:560048",
  );
  await expect.poll(() => state.logouts).toBe(2);
  await restore();
  await expect(records(page)).toContainText("900719925474099300000001");
  expect(state.reads).toBe(2);
  await viewport(page);
  expect(state.blocked).toEqual([]);
});
