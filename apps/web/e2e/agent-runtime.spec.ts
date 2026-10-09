import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Actual /agent page; every session/operation response is an explicit isolated
// browser fixture. Real HTTP/MySQL/session-boundary coverage is a separate suite.
const wallet = `0x${"a".repeat(40)}`;
const mode = "TEST_ONLY_NO_REAL_VALUE";
function status() {
  return {
    schemaVersion: 1,
    mode,
    productionReady: false,
    state: "TEST_ONLY_READY",
    adapterKind: "artfi-isolated-test-v1",
    walletProtocol: "NOT_CONFIRMED",
    constitutionalMutations: false,
    privateKeyCustody: false,
    capabilities: {
      prepareIntent: true,
      createIntent: true,
      queryIntent: true,
      recordRevocation: true,
      history: true,
      signIntent: false,
      revokeNonce: false,
      actionWorkflows: true,
      queryActions: true,
    },
    actions: [
      { action: "PARTIAL_FILL", available: true, testOnly: true },
      { action: "ACCEPT_OFFER", available: false },
    ],
    limitations: [
      "Isolated ArtFi integration-test adapter; not a wallet product contract.",
    ],
    observedAt: Date.now(),
  };
}
function workflow(id: string) {
  return {
    id,
    mode,
    supportLevel: "ISOLATED_APP_SIDE_CONTRACT",
    state: "COMPLETED",
    action: "AMEND_ORDER",
    marketKind: "FRACTION",
    wallet,
    chainId: "560048",
    asset: { contract: `0x${"c".repeat(40)}`, tokenId: "0" },
    cursor: 2,
    steps: [
      {
        name: "RETIRE",
        state: "COMPLETED",
        evidence: { kind: "CHAIN_EVENT", verified: true },
      },
      {
        name: "REPLACE",
        state: "COMPLETED",
        evidence: { kind: "ORDER_PUBLICATION", verified: true },
      },
    ],
    limits: {
      maxExecutions: "4",
      maxOpenOrders: "2",
      maxAggregateExposure: "1000",
      validUntil: "4000000000",
    },
    recoveryAttempts: 1,
    reason: null,
    observedAt: Date.now(),
  };
}
async function fixture(page: Page) {
  const state = {
    available: true,
    authenticated: true,
    queries: 0,
    writes: 0,
    invalid: false,
    wait: null as null | Promise<void>,
  };
  await page.addInitScript(
    ({ address }) => {
      let account = address,
        permitted = false;
      const listeners = new Map<string, Set<(...values: unknown[]) => void>>();
      const emit = (name: string, ...values: unknown[]) =>
        listeners.get(name)?.forEach((callback) => callback(...values));
      const provider = {
        isMetaMask: true,
        on(name: string, callback: (...values: unknown[]) => void) {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(callback);
        },
        removeListener(name: string, callback: (...values: unknown[]) => void) {
          listeners.get(name)?.delete(callback);
        },
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return "0x88bb0";
          if (method === "net_version") return "560048";
          if (method === "eth_accounts") return permitted ? [account] : [];
          if (method === "eth_requestAccounts") {
            permitted = true;
            emit("accountsChanged", [account]);
            return [account];
          }
          if (method === "wallet_requestPermissions") {
            permitted = true;
            emit("accountsChanged", [account]);
            return [{ parentCapability: "eth_accounts" }];
          }
          if (method === "wallet_getPermissions")
            return permitted ? [{ parentCapability: "eth_accounts" }] : [];
          if (method === "wallet_getCapabilities") return {};
          throw Error(
            "TEST_ONLY agent page refuses wallet signing and chain writes.",
          );
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider });
      (
        window as unknown as {
          TEST_ONLY_switchAgentWallet: (next: string) => void;
        }
      ).TEST_ONLY_switchAgentWallet = (next) => {
        account = next;
        emit("accountsChanged", [account]);
      };
    },
    { address: wallet },
  );
  await page.route("**/api/user/auth/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "logout") {
      state.authenticated = false;
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({
      status: state.authenticated ? 200 : 401,
      json: state.authenticated
        ? {
            session: {
              id: "TEST_ONLY-agent-session",
              address: wallet,
              chainId: 560048,
              expiresAt: Date.now() + 600000,
              accessExpiresAt: Date.now() + 60000,
            },
          }
        : {},
    });
  });
  await page.route("**/api/agent/**", async (route) => {
    if (route.request().method() !== "GET") state.writes++;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) {
      await route.fulfill({
        status: state.available ? 200 : 503,
        json: state.available
          ? status()
          : { code: "AGENT_RUNTIME_UNAVAILABLE", mode },
      });
      return;
    }
    if (path.endsWith("/history")) {
      await route.fulfill({
        json: {
          id: "TEST_ONLY-workflow",
          mode,
          events: [
            {
              id: "1",
              state: "STARTED",
              kind: "RETIRE",
              observedAt: Date.now(),
              version: 1,
            },
            {
              id: "2",
              state: "COMPLETED",
              kind: "REPLACE",
              observedAt: Date.now(),
              version: 2,
            },
          ],
          nextAfter: "2",
        },
      });
      return;
    }
    state.queries++;
    if (state.wait) await state.wait;
    const result = workflow("TEST_ONLY-workflow");
    if (state.invalid) result.steps[0].evidence.verified = false;
    await route.fulfill({ json: result }).catch(() => undefined);
  });
  return state;
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Browser Wallet|Injected|MetaMask/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Runtime capabilities" }),
  ).toBeVisible();
}
test("agent entry is reachable from Tools/mobile and private records require wallet authentication", async ({
  page,
  isMobile,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page
    .locator(isMobile ? ".mobile-menu > summary" : ".tools-menu > summary")
    .click();
  await page
    .getByRole("navigation", {
      name: isMobile ? "Mobile navigation" : "Workflow navigation",
      exact: true,
    })
    .getByRole("link", { name: "Bounded agent", exact: true })
    .click();
  await expect(page).toHaveURL(/\/agent$/);
  await expect(
    page.getByRole("heading", { name: "Bounded agent runtime." }),
  ).toBeVisible();
  await expect(
    page.getByText("Sign in with your wallet to read your intents", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.queries).toBe(0);
  await connect(page);
  await expect(
    page.getByText("TEST_ONLY · No real value", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-no-translate="true"][data-translation-skip="true"]')
      .filter({
        has: page.getByRole("heading", { name: "Runtime capabilities" }),
      }),
  ).toBeVisible();
  expect(state.writes).toBe(0);
});
test("authenticated durable workflow remains visibly isolated and renders verified history", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/agent");
  await connect(page);
  await page
    .getByLabel("Operation ID", { exact: true })
    .fill("TEST_ONLY-workflow");
  await page
    .getByRole("button", { name: "Read operation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workflow TEST_ONLY-workflow" }),
  ).toBeVisible();
  await expect(
    page.getByText("RETIRE: COMPLETED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("REPLACE: COMPLETED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Durable operation history" }),
  ).toBeVisible();
  await expect(
    page.getByText("No live signing or production execution is claimed.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.queries).toBe(1);
  expect(state.writes).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("runtime outage reconnects honestly and invalid completion evidence never appears confirmed", async ({
  page,
}) => {
  const state = await fixture(page);
  state.available = false;
  await page.goto("/agent");
  await connect(page);
  await expect(
    page.getByText("Runtime availability is unconfirmed."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read operation" }),
  ).toBeDisabled();
  state.available = true;
  await page.getByRole("button", { name: "Refresh runtime" }).click();
  await expect(
    page.getByRole("button", { name: "Read operation" }),
  ).toBeEnabled();
  state.invalid = true;
  await page
    .getByLabel("Operation ID", { exact: true })
    .fill("TEST_ONLY-workflow");
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "could not be verified",
  );
  await expect(
    page.getByRole("heading", { name: "Workflow TEST_ONLY-workflow" }),
  ).not.toBeVisible();
  expect(state.writes).toBe(0);
});
test("duplicate and interrupted reads cannot publish an old wallet's private response", async ({
  page,
}) => {
  const state = await fixture(page);
  let resolve!: () => void;
  state.wait = new Promise<void>((done) => {
    resolve = done;
  });
  await page.goto("/agent");
  await connect(page);
  await page
    .getByLabel("Operation ID", { exact: true })
    .fill("TEST_ONLY-workflow");
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(page.getByRole("button", { name: "Reading…" })).toBeDisabled();
  await page.evaluate(() => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.evaluate(
    (next) => {
      (
        window as unknown as {
          TEST_ONLY_switchAgentWallet: (next: string) => void;
        }
      ).TEST_ONLY_switchAgentWallet(next);
    },
    `0x${"b".repeat(40)}`,
  );
  resolve();
  await expect(
    page.getByRole("heading", { name: "Your agent operations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Workflow TEST_ONLY-workflow" }),
  ).not.toBeVisible();
  expect(state.queries).toBe(1);
  expect(state.writes).toBe(0);
});
