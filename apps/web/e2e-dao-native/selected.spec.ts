import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://dao-fixture.invalid",
  account = "0x5555555555555555555555555555555555555555",
  creation = "0x" + "d".repeat(64),
  now = Date.parse("2026-10-19T01:00:00Z");
async function open(page: Page, mode = "normal", authenticated = true) {
  const root = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(root)
      .filter((n) => /^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(n))
      .map((n) => ["/" + n, readFileSync(join(root, n), "utf8")]),
  );
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install({ time: new Date(now) });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    if (modules.has(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/javascript; charset=utf-8",
        body: modules.get(url.pathname)!,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (url.pathname.startsWith("/api/user/auth/")) {
      if (url.pathname.endsWith("/logout")) authenticated = false;
      await page.evaluate(() => window.daoFixture.auth());
      return route.fulfill({
        json: {
          session: authenticated
            ? {
                id: "e".repeat(32),
                address: account,
                chainId: 560048,
                expiresAt: now + 600000,
                accessExpiresAt: now + 600000,
              }
            : null,
        },
      });
    }
    blocked.push(url.pathname);
    return route.abort();
  });
  await page.goto(origin + "/?mode=" + mode);
  await expect(page.getByTestId("session-state")).toHaveText(
    authenticated ? "authenticated" : "unsigned",
  );
  return { blocked, errors };
}
const load = (page: Page) =>
  page.getByRole("button", { name: "Load published terms", exact: true });
const queue = (page: Page) =>
  page.getByRole("button", { name: "Queue reviewed proposal", exact: true });
const execute = (page: Page) =>
  page.getByRole("button", { name: "Execute reviewed proposal", exact: true });
const reconcile = (page: Page) =>
  page.getByRole("button", {
    name: "Check transaction confirmation",
    exact: true,
  });
const dump = (page: Page) => page.evaluate(() => window.daoFixture.dump());
async function review(page: Page) {
  await page
    .getByRole("textbox", {
      name: "Proposal creation transaction",
      exact: true,
    })
    .fill(creation);
  await load(page).click();
  await expect(
    page.getByRole("heading", { name: "Review exact on-chain terms" }),
  ).toBeVisible();
}
async function stopped(page: Page) {
  await expect(page.getByRole("alert")).toContainText("could not complete");
  expect((await dump(page)).writes).toEqual([]);
}

test("public terms can be reviewed without acquiring wallet authority", async ({
  page,
}, info) => {
  const net = await open(page, "normal", false);
  await review(page);
  await expect(queue(page)).toBeDisabled();
  await expect(execute(page)).toBeDisabled();
  await expect(
    page.getByText("TEST_ONLY published migration", { exact: true }),
  ).toBeVisible();
  await page.getByText("Exact execution and source", { exact: true }).click();
  await expect(page.getByText(/Creation transaction:/)).toContainText(creation);
  expect((await dump(page)).writes).toEqual([]);
  expect(net.blocked).toEqual([]);
  expect(net.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("dao-public-review.png"),
    fullPage: true,
  });
});
test("queue uses exact reviewed call only after final auth and fresh holder proof", async ({
  page,
}, info) => {
  const net = await open(page);
  await review(page);
  await queue(page).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("Published proposal queued");
  await expect(page.locator("body")).not.toContainText(
    "The unresolved transaction hash is retained",
  );
  const d = await dump(page);
  expect(d.writes).toHaveLength(1);
  expect(d.writes[0]).toMatchObject({
    functionName: "queue",
    account,
    chainId: 560048,
    address: "0x1111111111111111111111111111111111111111",
    state: 4,
    balance: "1",
  });
  expect(d.writes[0].input).toMatch(/^0x[0-9a-f]+$/);
  const auth = d.events.lastIndexOf("auth"),
    state = d.events.lastIndexOf("state"),
    holder = d.events.lastIndexOf("balanceOf"),
    sim = d.events.lastIndexOf("simulate"),
    wallet = d.events.lastIndexOf("wallet");
  expect(state).toBeGreaterThan(auth);
  expect(holder).toBeGreaterThan(state);
  expect(sim).toBeGreaterThan(holder);
  expect(wallet).toBeGreaterThan(sim);
  expect(net.blocked).toEqual([]);
  expect(net.errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("dao-queue-confirmed.png"),
    fullPage: true,
  });
});
test("only matured queued proposals reach exact execute callback", async ({
  page,
}) => {
  await open(page, "execute");
  await review(page);
  await expect(queue(page)).toBeDisabled();
  await execute(page).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("execution confirmed");
  expect((await dump(page)).writes[0]).toMatchObject({
    functionName: "execute",
    account,
    chainId: 560048,
    state: 5,
  });
});
test("unelapsed chain timelock never enables execution", async ({ page }) => {
  await open(page, "timelock");
  await review(page);
  await expect(queue(page)).toBeDisabled();
  await expect(execute(page)).toBeDisabled();
  expect((await dump(page)).writes).toEqual([]);
});
test("regression final auth: changed proposal state must not reach wallet", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.daoFixture.setMode("auth-state-change"));
  await queue(page).click();
  await stopped(page);
  expect((await dump(page)).state).toBe(7);
});
test("regression final auth: lost holder membership must not reach wallet", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() =>
    window.daoFixture.setMode("auth-membership-change"),
  );
  await queue(page).click();
  await stopped(page);
  expect((await dump(page)).balance).toBe("0");
});
test("changed proposal between public review and action is rejected", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.daoFixture.setState(7));
  await queue(page).click();
  await stopped(page);
});
test("two immediate action events do not create two wallet requests", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await queue(page).evaluate((e) => {
    (e as HTMLButtonElement).click();
    (e as HTMLButtonElement).click();
  });
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("Published proposal queued");
  expect((await dump(page)).writes).toHaveLength(1);
});
test("unknown receipt survives reload and reconciliation does not replay", async ({
  page,
}) => {
  await open(page, "unknown-receipt");
  await review(page);
  await queue(page).click();
  await expect(reconcile(page)).toBeEnabled();
  await expect(page.getByText(/Transaction:.*unknown/)).toBeVisible();
  const saved = await page.evaluate(() => Object.values(sessionStorage));
  expect(saved.some((value) => value.includes('"request"'))).toBe(true);
  expect((await dump(page)).writes).toHaveLength(1);
  await page.reload();
  await expect(reconcile(page)).toBeEnabled();
  await expect(load(page)).toBeDisabled();
  expect((await dump(page)).writes).toEqual([]);
  await page.evaluate(() => window.daoFixture.setMode("normal"));
  await reconcile(page).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("Saved transaction confirmed");
  expect((await dump(page)).writes).toEqual([]);
});
test("hashless wallet wait survives reload and blocks duplicate action", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.daoFixture.setMode("hold-wallet"));
  await queue(page).click();
  await expect.poll(async () => (await dump(page)).writes.length).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("no known transaction hash");
  await expect(load(page)).toBeDisabled();
  await expect(reconcile(page)).toHaveCount(0);
  expect((await dump(page)).writes).toEqual([]);
});
test("canonical repricing keeps the reviewed call and replaces known hash", async ({
  page,
}) => {
  await open(page, "repriced");
  await review(page);
  await queue(page).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("Published proposal queued");
  await expect(page.getByText(/Transaction:/)).toContainText(
    "0x" + "8".repeat(64),
  );
  expect((await dump(page)).writes).toHaveLength(1);
});
test("explicit wallet rejection frees only its own unresolved marker", async ({
  page,
}) => {
  await open(page, "reject-wallet");
  await review(page);
  await queue(page).click();
  await expect(
    page.getByRole("status").filter({
      hasText:
        /Published proposal|Saved transaction|no known transaction hash|declined/,
    }),
  ).toContainText("declined");
  await expect(load(page)).toBeEnabled();
  expect((await dump(page)).writes).toHaveLength(1);
  expect((await dump(page)).receipts).toBe(0);
});
test("account departure during simulation retires the old wallet callback", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.daoFixture.setMode("hold-simulate"));
  await queue(page).click();
  await expect.poll(async () => (await dump(page)).simulations).toBe(1);
  await page
    .getByRole("button", { name: "Switch TEST_ONLY account", exact: true })
    .click();
  await page.evaluate(() => window.daoFixture.release());
  await expect(page.getByTestId("session-state")).toHaveText("unsigned");
  expect((await dump(page)).writes).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "Review exact on-chain terms" }),
  ).toHaveCount(0);
});
test("chain departure retires a delayed public proposal read", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.daoFixture.setMode("hold-read"));
  await page
    .getByRole("textbox", {
      name: "Proposal creation transaction",
      exact: true,
    })
    .fill(creation);
  await load(page).click();
  await page
    .getByRole("button", { name: "Switch TEST_ONLY chain", exact: true })
    .click();
  await page.evaluate(() => window.daoFixture.release());
  await expect(page.getByTestId("session-state")).toHaveText("unsigned");
  await expect(
    page.getByRole("heading", { name: "Review exact on-chain terms" }),
  ).toHaveCount(0);
  expect((await dump(page)).writes).toEqual([]);
});
test("canonical observation is rechecked after final simulation", async ({
  page,
}) => {
  await open(page);
  await review(page);
  await page.evaluate(() => window.daoFixture.setMode("reorg-final"));
  await queue(page).click();
  await stopped(page);
  expect((await dump(page)).simulations).toBe(2);
});
test("duplicate original creation events are rejected before review", async ({
  page,
}) => {
  await open(page, "duplicate-event");
  await page
    .getByRole("textbox", {
      name: "Proposal creation transaction",
      exact: true,
    })
    .fill(creation);
  await load(page).click();
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  await expect(queue(page)).toHaveCount(0);
  expect((await dump(page)).writes).toEqual([]);
});

test("native review controls remain inside the viewport and receive pointer hits", async ({
  page,
}, info) => {
  await open(page);
  await review(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  for (const target of [
    queue(page),
    page.getByText("Exact execution and source", { exact: true }),
  ]) {
    await target.scrollIntoViewIfNeeded();
    expect(
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return !!hit && (hit === el || el.contains(hit));
      }),
    ).toBe(true);
    expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: info.outputPath("dao-native-ready.png"),
    fullPage: true,
  });
});
