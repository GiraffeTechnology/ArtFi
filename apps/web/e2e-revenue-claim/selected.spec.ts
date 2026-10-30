import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
const origin = "https://revenue-fixture.invalid",
  account = "0x1000000000000000000000000000000000000003",
  now = Date.parse("2026-10-18T21:40:00Z");
async function open(page: Page) {
  const fixtureRoot = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(fixtureRoot)
      .filter((name) => /^[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(name))
      .map((name) => [
        "/" + name,
        readFileSync(join(fixtureRoot, name), "utf8"),
      ]),
  );
  const blocked: string[] = [];
  let authenticated = true;
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
      await page.evaluate(() => window.revenueFixture.auth());
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
  await page.goto(origin);
  await expect(page.getByTestId("session-state")).toHaveText("authenticated");
  await expect(
    page.getByRole("button", { name: "Read distribution", exact: true }),
  ).toBeEnabled();
  return { blocked };
}
const claim = (page: Page) =>
  page.getByRole("button", { name: "Confirm claim in wallet", exact: true });
async function inspect(page: Page) {
  await page
    .getByRole("button", { name: "Read distribution", exact: true })
    .click();
  await expect(
    page.getByText("Your claimable amount: 30. Already claimed: no.", {
      exact: true,
    }),
  ).toBeVisible();
}
const dump = (page: Page) => page.evaluate(() => window.revenueFixture.dump());
test("actual revenue page shows attributed snapshot units and renders native desktop/mobile controls", async ({
  page,
}, info) => {
  const { blocked } = await open(page);
  await inspect(page);
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => window.innerWidth)).toBe(viewport.width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  await claim(page).scrollIntoViewIfNeeded();
  expect(
    await claim(page).evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return hit === element || element.contains(hit);
    }),
  ).toBe(true);
  await expect(page.getByText(/historical balances/)).toBeVisible();
  await expect(page.getByText(/without fiat conversion/)).toBeVisible();
  await expect(page.getByText(/observation reserves nothing/)).toBeVisible();
  expect((await dump(page)).writes).toEqual([]);
  expect(blocked).toEqual([]);
  await page.screenshot({
    path: info.outputPath("revenue-ready.png"),
    fullPage: true,
  });
});
test.describe("callback boundary regressions", () => {
  test("fresh entitlement follows the final asynchronous authentication boundary", async ({
    page,
  }) => {
    await open(page);
    await inspect(page);
    await page.evaluate(() =>
      window.revenueFixture.setMode("auth-after-simulation"),
    );
    await claim(page).click();
    await expect(
      page.getByText(/The claim transaction confirmed/),
    ).toBeVisible();
    const d = await dump(page);
    expect(d.writes).toHaveLength(1);
    expect(d.writes[0].claimed).toBe(false);
    const lastAuth = d.events.lastIndexOf("auth"),
      lastRead = d.events.lastIndexOf("claimed"),
      sim = d.events.lastIndexOf("simulate"),
      wallet = d.events.lastIndexOf("wallet");
    expect(lastRead).toBeGreaterThan(lastAuth);
    expect(sim).toBeGreaterThan(lastRead);
    expect(wallet).toBeGreaterThan(sim);
  });
  test("a simulation-time reorg never reaches the wallet callback", async ({
    page,
  }) => {
    await open(page);
    await inspect(page);
    await page.evaluate(() =>
      window.revenueFixture.setMode("reorg-on-simulate"),
    );
    await claim(page).click();
    await expect(
      page.getByText(
        /The claim (?:transaction confirmed|did not reach a verified completion)/,
      ),
    ).toBeVisible();
    expect((await dump(page)).writes).toEqual([]);
    await expect(
      page.getByText(/The claim did not reach a verified completion/),
    ).toBeVisible();
  });
});
test("claim sends only the reviewed distribution to the exact existing account and distributor", async ({
  page,
}) => {
  const { blocked } = await open(page);
  await inspect(page);
  await claim(page).click();
  await expect(page.getByText(/The claim transaction confirmed/)).toBeVisible();
  expect((await dump(page)).writes).toEqual([
    {
      address: "0x1000000000000000000000000000000000000001",
      args: ["1"],
      account,
      chainId: 560048,
      claimed: false,
    },
  ]);
  expect(blocked).toEqual([]);
});
test("an entitlement already claimed during authentication is refused before simulation", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page.evaluate(() =>
    window.revenueFixture.setMode("claimed-during-auth"),
  );
  await claim(page).click();
  await expect(
    page.getByText(/The claim did not reach a verified completion/),
  ).toBeVisible();
  const d = await dump(page);
  expect(d.writes).toEqual([]);
  expect(d.simulations).toBe(0);
});
test("a wallet rejection is not confirmed and does not manufacture a transaction hash", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page.evaluate(() => window.revenueFixture.setMode("reject-wallet"));
  await claim(page).click();
  await expect(
    page.getByText(/The claim did not reach a verified completion/),
  ).toBeVisible();
  await expect(page.getByText(/Latest transaction:/)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((k) => k.startsWith("artfi:pending:")),
    ),
  ).toEqual([]);
});
test("an unknown submitted receipt persists across reload and requires read-only reconciliation", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page.evaluate(() => window.revenueFixture.setMode("unknown-receipt"));
  await claim(page).click();
  await expect(
    page.getByText(/A revenue transaction is unresolved/),
  ).toBeVisible();
  expect((await dump(page)).writes).toHaveLength(1);
  const before = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([k]) =>
      k.startsWith("artfi:pending:"),
    ),
  );
  expect(before).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId("session-state")).toHaveText("authenticated");
  await expect(
    page.getByText(/A revenue transaction is unresolved/),
  ).toBeVisible();
  expect((await dump(page)).writes).toEqual([]);
  await inspect(page);
  await expect(claim(page)).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Check pending claim transaction",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/The pending transaction is confirmed/),
  ).toBeVisible();
  expect((await dump(page)).writes).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([k]) =>
        k.startsWith("artfi:pending:"),
      ),
    ),
  ).toEqual([]);
});
test("malformed contract values are unavailable rather than a claim entitlement", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.revenueFixture.setMode("malformed"));
  await page
    .getByRole("button", { name: "Read distribution", exact: true })
    .click();
  await expect(
    page.getByText(/This distribution could not be read/),
  ).toBeVisible();
  await expect(claim(page)).toHaveCount(0);
  expect((await dump(page)).writes).toEqual([]);
});
test("a stalled read retires after the existing deadline and its late result never enables a claim", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.revenueFixture.setMode("hold-read"));
  await page
    .getByRole("button", { name: "Read distribution", exact: true })
    .click();
  await expect.poll(async () => (await dump(page)).reads).toBeGreaterThan(0);
  await page.clock.fastForward(12001);
  await expect(
    page.getByText(/This distribution could not be read/),
  ).toBeVisible();
  await page.evaluate(() => {
    window.revenueFixture.setMode("normal");
    window.revenueFixture.release();
  });
  await expect(claim(page)).toHaveCount(0);
  expect((await dump(page)).writes).toEqual([]);
});
test("wallet departure during simulation retires the original operation without a submission", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page.evaluate(() => window.revenueFixture.setMode("hold-simulate"));
  await claim(page).click();
  await expect.poll(async () => (await dump(page)).simulations).toBe(1);
  await page
    .getByRole("button", { name: "Disconnect TEST_ONLY wallet", exact: true })
    .click();
  await expect(
    page.getByText(/Sign in with the connected Hoodi wallet/),
  ).toBeVisible();
  await page.evaluate(() => window.revenueFixture.release());
  expect((await dump(page)).writes).toEqual([]);
});
test("duplicate clicks while a simulation is pending retain one original claim", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page.evaluate(() => window.revenueFixture.setMode("hold-simulate"));
  await claim(page).dblclick();
  await expect.poll(async () => (await dump(page)).simulations).toBe(1);
  await page.evaluate(() => {
    window.revenueFixture.setMode("normal");
    window.revenueFixture.release();
  });
  await expect(page.getByText(/The claim transaction confirmed/)).toBeVisible();
  expect((await dump(page)).writes).toHaveLength(1);
});
test("a changed distribution ID retires the old review and invalid IDs never read the contracts", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  await page
    .getByRole("textbox", { name: "Distribution ID", exact: true })
    .fill("0");
  await expect(claim(page)).toHaveCount(0);
  const reads = (await dump(page)).reads;
  await page
    .getByRole("button", { name: "Read distribution", exact: true })
    .click();
  await expect(
    page.getByText(/This distribution could not be read/),
  ).toBeVisible();
  expect((await dump(page)).reads).toBe(reads);
});
test("a different chain hides private entitlement before another contract read", async ({
  page,
}) => {
  await open(page);
  await inspect(page);
  const reads = (await dump(page)).reads;
  await page
    .getByRole("button", { name: "Switch TEST_ONLY chain", exact: true })
    .click();
  await expect(
    page.getByText(/Sign in with the connected Hoodi wallet/),
  ).toBeVisible();
  await expect(claim(page)).toHaveCount(0);
  expect((await dump(page)).reads).toBe(reads);
});
test("zero historical balance does not offer a claim despite connected wallet state", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => window.revenueFixture.setMode("zero-balance"));
  await page
    .getByRole("button", { name: "Read distribution", exact: true })
    .click();
  await expect(
    page.getByText("Your claimable amount: 0. Already claimed: no.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(claim(page)).toBeDisabled();
  expect((await dump(page)).writes).toEqual([]);
});

const pendingRecords = (page: Page) =>
  page.evaluate(() =>
    Object.entries(sessionStorage)
      .filter(([key]) => key.startsWith("artfi:pending:"))
      .map(([, value]) => JSON.parse(value)),
  );
const checkPending = (page: Page) =>
  page.getByRole("button", {
    name: "Check pending claim transaction",
    exact: true,
  });
for (const mode of [
  "receipt-wrong-hash",
  "receipt-reorg",
  "receipt-reorg-revert",
  "receipt-wrong-nonce",
  "receipt-changed-call",
  "receipt-unknown-status",
  "receipt-missing-original",
  "receipt-chain-flip",
] as const) {
  test(`canonical revenue: ${mode} survives reload without another claim`, async ({
    page,
  }) => {
    const { blocked } = await open(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await inspect(page);
    await page.evaluate((value) => window.revenueFixture.setMode(value), mode);
    await claim(page).click();
    await expect(
      page.getByText(/A revenue transaction is unresolved/),
    ).toBeVisible();
    const saved = await pendingRecords(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].hash).toBe(`0x${"7".repeat(64)}`);
    await expect(claim(page)).toHaveCount(0);
    expect((await dump(page)).writes).toHaveLength(1);
    await expect(page.getByText(/The claim transaction confirmed/)).toHaveCount(
      0,
    );
    await page.reload();
    await expect(page.getByTestId("session-state")).toHaveText("authenticated");
    await inspect(page);
    await expect(claim(page)).toBeDisabled();
    await checkPending(page).click();
    await expect(
      page.getByText(/The pending transaction is confirmed/),
    ).toBeVisible();
    expect(await pendingRecords(page)).toEqual([]);
    expect((await dump(page)).writes).toEqual([]);
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test("canonical revenue: verified repricing confirms the actual same-call hash", async ({
  page,
}) => {
  const { blocked } = await open(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await inspect(page);
  await page.evaluate(() => window.revenueFixture.setMode("receipt-repriced"));
  await claim(page).click();
  await expect(page.getByText(/The claim transaction confirmed/)).toBeVisible();
  await expect(page.getByText(/Latest transaction:/)).toContainText(
    `0x${"8".repeat(64)}`,
  );
  expect(await pendingRecords(page)).toEqual([]);
  expect((await dump(page)).writes).toHaveLength(1);
  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
});
for (const mode of [
  "receipt-cancelled",
  "receipt-replaced",
  "receipt-reverted",
] as const) {
  test(`canonical revenue: proven ${mode} permits a separate deliberate retry`, async ({
    page,
  }) => {
    const { blocked } = await open(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await inspect(page);
    await page.evaluate((value) => window.revenueFixture.setMode(value), mode);
    await claim(page).click();
    await expect(
      page.getByText(/The claim did not reach a verified completion/),
    ).toBeVisible();
    expect(await pendingRecords(page)).toEqual([]);
    await expect(page.getByText(/The claim transaction confirmed/)).toHaveCount(
      0,
    );
    await page.evaluate(() => window.revenueFixture.setMode("normal"));
    await inspect(page);
    await claim(page).click();
    await expect(
      page.getByText(/The claim transaction confirmed/),
    ).toBeVisible();
    expect((await dump(page)).writes).toHaveLength(2);
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  });
}
for (const mode of ["hold-receipt", "late-repriced-receipt"] as const) {
  test(`canonical revenue: ${mode} deadline keeps the original journal and ignores late completion`, async ({
    page,
  }, info) => {
    const { blocked } = await open(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await inspect(page);
    await page.evaluate((value) => window.revenueFixture.setMode(value), mode);
    await claim(page).click();
    await expect.poll(async () => (await dump(page)).receiptCalls).toBe(1);
    await expect(claim(page)).toHaveCount(0);
    await page.clock.fastForward(15001);
    await expect(
      page.getByText(/A revenue transaction is unresolved/),
    ).toBeVisible();
    expect((await pendingRecords(page))[0].hash).toBe(`0x${"7".repeat(64)}`);
    await page.evaluate(() => window.revenueFixture.release());
    await page.clock.fastForward(1);
    expect((await pendingRecords(page))[0].hash).toBe(`0x${"7".repeat(64)}`);
    await expect(page.getByText(/The claim transaction confirmed/)).toHaveCount(
      0,
    );
    expect((await dump(page)).writes).toHaveLength(1);
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
    if (mode === "late-repriced-receipt")
      await page.screenshot({
        path: info.outputPath("revenue-canonical-unknown.png"),
        fullPage: true,
      });
  });
}
