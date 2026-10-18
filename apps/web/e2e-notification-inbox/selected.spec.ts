import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "https://notification-inbox-fixture.invalid";
const address = "0x6666666666666666666666666666666666666666";
const tx = "0x" + "a".repeat(64),
  contract = "0x" + "b".repeat(40),
  noticeID = "c".repeat(32),
  eventID = "d".repeat(32);
const now = Date.parse("2026-10-18T20:00:00Z");
function body(chain = 560048) {
  return {
    address,
    chainId: chain,
    chainEventsAvailable: chain === 560048,
    preferences: {
      revision: "3",
      transactionAlerts: true,
      systemMessageAlerts: true,
    },
    notifications: [
      {
        id: noticeID,
        sourceKey: "platform:service_notice",
        sourceKind: "system_notice",
        sourceRevision: "4",
        state: "published",
        read: false,
        readAt: null,
        messageCode: "service_notice",
        event: null,
        text: "TEST_ONLY published notice, not an institution record",
      },
      ...(chain === 560048
        ? [
            {
              id: eventID,
              sourceKey: `${chain}:${tx}:9`,
              sourceKind: "chain_event",
              sourceRevision: "5",
              state: "removed",
              read: false,
              readAt: null,
              messageCode: "event_removed",
              event: {
                transactionHash: tx,
                logIndex: 9,
                contractAddress: contract,
                eventName: "IntentFilled",
                blockNumber: "900719925474099300000001",
              },
              text: null,
            },
          ]
        : []),
    ],
  };
}
type Mode =
  | "normal"
  | "hold-list"
  | "hold-read"
  | "read-unknown"
  | "prefs-conflict"
  | "wrong-identity"
  | "withdrawn";
async function open(page: Page, chain = 560048) {
  const bundle = readFileSync(process.env.ARTFI_PORTFOLIO_FIXTURE!, "utf8"),
    css = readFileSync(
      process.env.ARTFI_PORTFOLIO_FIXTURE!.replace(/fixture\.js$/, "style.css"),
      "utf8",
    );
  const state = {
    authenticated: false,
    reads: 0,
    marks: 0,
    saves: 0,
    logouts: 0,
    mode: "normal" as Mode,
    page: body(chain),
    blocked: [] as string[],
    keys: [] as string[],
    release: undefined as (() => void) | undefined,
    settled: false,
    aborted: [] as string[],
  };
  await page.clock.install({ time: new Date(now) });
  page.on("requestfailed", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/notifications/"))
      state.aborted.push(new URL(r.url()).pathname);
  });
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
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
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>',
      });
    if (url.pathname.startsWith("/api/user/auth/")) {
      if (url.pathname.endsWith("/logout")) {
        state.authenticated = false;
        state.logouts++;
      }
      return route.fulfill({
        json: {
          session: state.authenticated
            ? {
                id: "e".repeat(32),
                address,
                chainId: chain,
                expiresAt: now + 600_000,
                accessExpiresAt: now + 600_000,
              }
            : null,
        },
      });
    }
    if (!url.pathname.startsWith("/api/notifications/")) {
      state.blocked.push(url.pathname);
      return route.abort();
    }
    expect(request.headers()["x-artfi-wallet"]).toBe(address);
    expect(request.headers()["x-artfi-chain"]).toBe(String(chain));
    expect(request.headers()["x-artfi-session"]).toBe("e".repeat(32));
    const mode = state.mode;
    let hold = false;
    if (url.pathname.endsWith("/inbox")) {
      expect(request.method()).toBe("GET");
      state.reads++;
      hold = mode === "hold-list";
    } else if (url.pathname.endsWith("/read")) {
      expect(request.method()).toBe("POST");
      state.marks++;
      expect(request.postDataJSON()).toEqual({
        id: noticeID,
        expectedSourceRevision: "4",
      });
      const key = request.headers()["idempotency-key"];
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      state.keys.push(key);
      state.page.notifications[0].read = true;
      state.page.notifications[0].readAt = "2026-10-18T20:00:01Z" as never;
      if (mode === "read-unknown") return route.abort("failed");
      hold = mode === "hold-read";
    } else if (url.pathname.endsWith("/preferences")) {
      expect(request.method()).toBe("PUT");
      state.saves++;
      expect(request.postDataJSON()).toEqual({
        revision: "3",
        transactionAlerts: false,
        systemMessageAlerts: true,
      });
      const key = request.headers()["idempotency-key"];
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      state.keys.push(key);
      if (mode === "prefs-conflict")
        return route.fulfill({
          status: 409,
          json: { error: "TEST_ONLY stale revision" },
        });
      state.page.preferences = {
        revision: "4",
        transactionAlerts: false,
        systemMessageAlerts: true,
      };
      state.page.notifications = state.page.notifications.filter(
        (n) => n.sourceKind !== "chain_event",
      );
    } else {
      state.blocked.push(url.pathname);
      return route.abort();
    }
    if (hold)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    const response = structuredClone(state.page);
    if (mode === "wrong-identity") response.address = contract;
    if (mode === "withdrawn") {
      response.notifications[0].state = "withdrawn";
      response.notifications[0].text = null as never;
    }
    try {
      return await route.fulfill({ json: response });
    } catch {
      return;
    } finally {
      if (hold) state.settled = true;
    }
  });
  await page.goto(origin + "/?network=" + chain);
  await page
    .getByRole("button", { name: "Connect TEST_ONLY wallet", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    `connected:${chain}`,
  );
  const restore = async () => {
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
const list = (page: Page) =>
  page.getByRole("list", { name: "Current notifications", exact: true });
const notice = (page: Page) =>
  list(page)
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: "System message", exact: true }),
    });
const mark = (page: Page) =>
  notice(page).getByRole("button", { name: "Mark read", exact: true });
const refresh = (page: Page) =>
  page.getByRole("button", { name: "Refresh", exact: true });
const ready = async (page: Page) => {
  await expect(list(page)).toBeVisible();
};
async function width(page: Page) {
  const v = await page.evaluate(() => ({
    actual: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(v.actual).toBeLessThanOrEqual(v.viewport);
}
async function release(
  page: Page,
  state: { release?: () => void; settled: boolean },
) {
  state.release?.();
  await expect.poll(() => state.settled).toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
test("unsigned inbox performs no private read or mutation", async ({
  page,
}) => {
  const { state } = await open(page);
  await expect(
    page.getByText("Connecting an address alone does not sign you in.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  expect([state.reads, state.marks, state.saves]).toEqual([0, 0, 0]);
  expect(state.blocked).toEqual([]);
});
test("authenticated inbox retains exact source facts and removed-event meaning on mobile", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  await expect(list(page)).toContainText("removed");
  await expect(list(page)).toContainText(tx);
  await expect(list(page)).toContainText("900719925474099300000001");
  await expect(
    page.getByText("These settings apply to this wallet and chain.", {
      exact: false,
    }),
  ).toContainText("do not send email or browser push");
  expect(state.reads).toBe(1);
  await width(page);
  await page.screenshot({
    path: test.info().outputPath("inbox-ready.png"),
    fullPage: true,
  });
  expect(state.blocked).toEqual([]);
});
test("read acknowledgement changes only after exact revision response", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  state.mode = "hold-read";
  await mark(page).click();
  await expect.poll(() => state.marks).toBe(1);
  await expect(notice(page).getByText("Unread", { exact: true })).toBeVisible();
  await expect(mark(page)).toBeDisabled();
  await release(page, state);
  await expect(notice(page).getByText("Read", { exact: true })).toBeVisible();
  await expect(mark(page)).toHaveCount(0);
  expect(state.reads).toBe(1);
  expect(state.keys).toHaveLength(1);
  expect(state.blocked).toEqual([]);
});
test("unknown write result retires private content and manual refresh reconciles without replay", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  state.mode = "read-unknown";
  await mark(page).click();
  await expect(page.getByRole("alert")).toContainText("Refresh to reconcile");
  await expect(list(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Delivery preferences", exact: true }),
  ).toHaveCount(0);
  expect([state.reads, state.marks, state.saves]).toEqual([1, 1, 0]);
  state.mode = "normal";
  await refresh(page).click();
  await ready(page);
  await expect(notice(page).getByText("Read", { exact: true })).toBeVisible();
  expect([state.reads, state.marks, state.saves]).toEqual([2, 1, 0]);
  expect(state.blocked).toEqual([]);
});
test("delivery preference CAS updates authoritative revision without claiming push", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  await page
    .getByRole("checkbox", { name: "Transaction alerts", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Transaction alerts", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save preferences", exact: true }),
  ).toBeDisabled();
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  expect([state.reads, state.saves]).toEqual([1, 1]);
  expect(state.keys).toHaveLength(1);
  expect(state.blocked).toEqual([]);
});
test("stale preference revision requires reconciliation and never automatically saves again", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  state.mode = "prefs-conflict";
  await page
    .getByRole("checkbox", { name: "Transaction alerts", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Refresh to reconcile");
  await expect(list(page)).toHaveCount(0);
  expect(state.saves).toBe(1);
  state.mode = "normal";
  await refresh(page).click();
  await ready(page);
  await expect(
    page.getByRole("checkbox", { name: "Transaction alerts", exact: true }),
  ).toBeChecked();
  expect([state.reads, state.saves]).toEqual([2, 1]);
  expect(state.blocked).toEqual([]);
});
test("wrong session identity is refused before displaying notification text", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "wrong-identity";
  await restore();
  await expect(page.getByRole("alert")).toContainText("unavailable");
  await expect(list(page)).toHaveCount(0);
  await expect(
    page.getByText("TEST_ONLY published notice, not an institution record", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.reads).toBe(1);
  expect(state.blocked).toEqual([]);
});
test("withdrawn system notice never displays retired text or a read action", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "withdrawn";
  await restore();
  await ready(page);
  await expect(notice(page)).toContainText("withdrawn");
  await expect(
    page.getByText("TEST_ONLY published notice, not an institution record", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(mark(page)).toHaveCount(0);
  expect(state.marks).toBe(0);
  expect(state.blocked).toEqual([]);
});
test("sign out aborts pending inbox and a late response cannot restore content", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  state.mode = "hold-list";
  await restore();
  await expect.poll(() => state.reads).toBe(1);
  await page
    .getByRole("button", { name: "End TEST_ONLY session", exact: true })
    .click();
  await expect(page.getByTestId("real-session-state")).toHaveText("unsigned");
  await expect.poll(() => state.aborted.length).toBe(1);
  await release(page, state);
  await expect(list(page)).toHaveCount(0);
  expect(state.reads).toBe(1);
  expect(state.blocked).toEqual([]);
});
test("session expiry removes inbox and controls without a new private request", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  await page.clock.fastForward(600_001);
  await expect(list(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Delivery preferences", exact: true }),
  ).toHaveCount(0);
  expect([state.reads, state.marks, state.saves]).toEqual([1, 0, 0]);
  expect(state.blocked).toEqual([]);
});
test("network change retires old private facts and requires a new session", async ({
  page,
}) => {
  const { state, restore } = await open(page);
  await restore();
  await ready(page);
  await page
    .getByRole("button", { name: "Switch TEST_ONLY Base", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    "connected:8453",
  );
  await expect(page.getByTestId("real-session-state")).toHaveText("unsigned");
  await expect(list(page)).toHaveCount(0);
  expect(state.reads).toBe(1);
  expect(state.blocked).toEqual([]);
});
test("nonindexed network keeps published messages and labels absent chain alerts", async ({
  page,
}) => {
  const { state, restore } = await open(page, 8453);
  await restore();
  await ready(page);
  await expect(
    page.getByText(
      "Transaction alerts from the indexed chain are unavailable on this network.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  await expect(list(page)).not.toContainText(tx);
  expect(state.reads).toBe(1);
  await width(page);
  expect(state.blocked).toEqual([]);
});
