import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {} from "./fixtures/main";
import type { NftPlan, NftRequest } from "../src/lib/nft/model";
const origin = "https://nft-review-fixture.invalid",
  account = "0x1111111111111111111111111111111111111111",
  hash = `0x${"ab".repeat(32)}`,
  seaport = "0x0000000000000068F116a894984e2DB1123eB395";
const scope = {
  slug: "test-only-digital",
  chain: "ethereum" as const,
  contract: "0x2222222222222222222222222222222222222222" as const,
  standard: "erc1155" as const,
  label: "TEST_ONLY digital collection",
  charity: false,
};
const token = {
  tokenId: "7",
  name: "TEST_ONLY digital edition",
  contract: scope.contract,
  standard: scope.standard,
  collection: scope.slug,
};
type Operation = {
  id: string;
  status: string;
  walletStarted?: boolean;
  plan: NftPlan;
  transactionHash?: string;
  orderHash?: string;
};
async function open(
  page: Page,
  mode = "normal",
  kind: "signature" | "approval" | "transaction" = "signature",
) {
  const root = dirname(process.env.ARTFI_PORTFOLIO_FIXTURE!);
  const modules = new Map(
    readdirSync(root)
      .filter((n) => /^[a-zA-Z0-9_.-]+\.(js|css)$/.test(n))
      .map((n) => ["/" + n, readFileSync(join(root, n), "utf8")]),
  );
  const blocked: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = {
    operation: null as Operation | null,
    prepare: 0,
    review: 0,
    start: 0,
    sign: 0,
    broadcast: 0,
    uncertain: 0,
    status: 0,
    reconcile: false,
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      blocked.push(url.href);
      return route.abort();
    }
    if (modules.has(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: modules.get(url.pathname)!,
      });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    if (url.pathname.startsWith("/api/user/auth/"))
      return route.fulfill({
        json: {
          session: {
            id: "e".repeat(32),
            address: account,
            chainId: 1,
            expiresAt: Date.now() + 600000,
            accessExpiresAt: Date.now() + 600000,
          },
        },
      });
    if (!url.pathname.startsWith("/api/nft/")) {
      blocked.push(url.pathname);
      return route.abort();
    }
    const action = url.pathname.split("/").pop();
    if (action === "config")
      return route.fulfill({
        json: { collections: [scope], tradingEnabled: true },
      });
    if (action === "catalog")
      return route.fulfill({
        json: {
          data: [token],
          next: null,
          scope,
          source: "opensea",
          observedAt: "2026-10-19T11:00:00Z",
        },
      });
    if (action === "detail")
      return route.fulfill({
        json: {
          nft: token,
          scope,
          orders: [],
          ordersUnavailable: false,
          observedAt: "2026-10-19T11:00:00Z",
        },
      });
    const body = route.request().postDataJSON();
    if (action === "prepare") {
      state.prepare++;
      const request = body.request as NftRequest;
      const plan: NftPlan = {
        id: "TEST_ONLY-plan",
        operationId: body.operationId,
        sessionId: "e".repeat(32),
        chainId: 1,
        request,
        scope,
        expiresAt: Date.now() + 120000,
        kind,
        summary: "TEST_ONLY reviewed digital NFT",
        fees: [],
        ...(kind === "signature"
          ? {
              typedData: {
                domain: {
                  name: "Seaport",
                  version: "1.6",
                  chainId: 1,
                  verifyingContract: seaport,
                },
                primaryType: "OrderComponents",
                types: {
                  OrderComponents: [{ name: "offerer", type: "address" }],
                },
                message: { offerer: account },
              },
            }
          : {
              transaction: {
                to: kind === "approval" ? scope.contract : seaport,
                data: "0x12345678",
                value: "0",
              },
            }),
      };
      if (mode === "unknown-kind") Reflect.set(plan, "kind", "other");
      if (mode === "string-expiry")
        Reflect.set(plan, "expiresAt", String(Date.now() + 120000));
      if (mode === "odd-data") plan.transaction!.data = "0x123456789";
      if (mode === "mixed-data") Reflect.set(plan, "typedData", {});
      state.operation = {
        id: body.operationId,
        status: "awaiting-wallet",
        plan,
      };
      return route.fulfill({ json: state.operation });
    }
    if (!state.operation)
      return route.fulfill({
        status: 404,
        json: { detail: "TEST_ONLY no operation" },
      });
    if (action === "review") {
      state.review++;
      if (state.operation.walletStarted)
        return route.fulfill({
          status: 409,
          json: {
            detail:
              "A wallet request was already started. Reconcile it before another request.",
          },
        });
      if (mode === "changed-review")
        return route.fulfill({
          json: {
            ...state.operation,
            plan: {
              ...state.operation.plan,
              summary: "Unreviewed changed terms",
            },
          },
        });
    }
    if (action === "wallet-start") {
      state.start++;
      state.operation.walletStarted = true;
      if (mode === "start-ack-lost")
        return route.fulfill({
          status: 503,
          json: { detail: "TEST_ONLY wallet-start response lost" },
        });
    }
    if (action === "sign") {
      state.sign++;
      state.operation.status = "accepted";
      state.operation.orderHash = hash;
    }
    if (action === "broadcast") {
      state.broadcast++;
      state.operation.transactionHash = body.transactionHash;
      state.operation.status = state.reconcile ? "confirmed" : "submitted";
      if (mode === "broadcast-ack-lost" && !state.reconcile)
        return route.fulfill({
          status: 503,
          json: { detail: "TEST_ONLY broadcast acknowledgement lost" },
        });
    }
    if (action === "wallet-uncertain") {
      state.uncertain++;
      state.operation.status = "unknown";
    }
    if (action === "wallet-rejected") state.operation.status = "rejected";
    if (action === "status") {
      state.status++;
      if (state.reconcile) state.operation.status = "confirmed";
    }
    return route.fulfill({ json: state.operation });
  });
  await page.goto(origin);
  await expect(page.getByTestId("session-state")).toHaveText("authenticated");
  await page.evaluate((m) => window.nftFixture.setMode(m), mode);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review", exact: true }),
  ).toBeVisible();
  return {
    state,
    async clean(signs = 0, sends = 0) {
      expect(await page.evaluate(() => window.nftFixture.dump())).toMatchObject(
        { signs, sends },
      );
      expect(blocked).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
const confirm = (p: Page) =>
  p.getByRole("button", { name: "Confirm in wallet", exact: true });
const recover = (p: Page) =>
  p.getByRole("button", { name: "Check / recover operation", exact: true });
test("native signing requires the same reviewed terms and reports venue acceptance without claiming settlement", async ({
  page,
}, info) => {
  const c = await open(page);
  await confirm(page).click();
  await expect(
    page.getByText("Status: accepted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "OpenSea accepted the order. This does not confirm settlement.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(c.state.start).toBe(1);
  expect(c.state.sign).toBe(1);
  expect(c.state.broadcast).toBe(0);
  await page.screenshot({
    path: info.outputPath("nft-native-accepted.png"),
    fullPage: true,
  });
  await c.clean(1, 0);
});
for (const kind of ["approval", "transaction"] as const)
  test(`native ${kind} preserves the original broadcast hash until reconciliation`, async ({
    page,
  }) => {
    const c = await open(page, "normal", kind);
    await confirm(page).click();
    await expect(
      page.getByText("Status: submitted", { exact: true }),
    ).toBeVisible();
    await expect(confirm(page)).toBeDisabled();
    const saved = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem(
          "artfi:nft:recovery:1:0x1111111111111111111111111111111111111111",
        )!,
      ),
    );
    expect(saved.hash).toBe(hash);
    expect(saved.id).toBe(c.state.operation!.id);
    c.state.reconcile = true;
    await recover(page).click();
    await expect(
      page.getByText("Status: confirmed", { exact: true }),
    ).toBeVisible();
    expect(c.state.start).toBe(1);
    await c.clean(0, 1);
  });
for (const mode of [
  "unknown-kind",
  "string-expiry",
  "odd-data",
  "mixed-data",
  "changed-review",
])
  test(`invalid native review ${mode} is rejected before wallet-start and wallet callbacks`, async ({
    page,
  }) => {
    const kind =
      mode === "odd-data" || mode === "mixed-data"
        ? "transaction"
        : "signature";
    const c = await open(page, mode, kind);
    await confirm(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: /changed|invalid/ }),
    ).toBeVisible();
    expect(c.state.start).toBe(0);
    expect(c.state.sign).toBe(0);
    expect(c.state.broadcast).toBe(0);
    await c.clean();
  });
test("wallet-start acknowledgement loss is reconciled before any wallet prompt", async ({
  page,
}) => {
  const c = await open(page, "start-ack-lost", "transaction");
  await confirm(page).click();
  await expect(
    page.getByText("TEST_ONLY wallet-start response lost", { exact: true }),
  ).toBeVisible();
  await recover(page).click();
  await expect(confirm(page)).toBeDisabled();
  await page.reload();
  await recover(page).click();
  await expect(confirm(page)).toBeDisabled();
  expect(c.state.start).toBe(1);
  await c.clean();
});
test("uncertain wallet response preserves the original recovery identity across reload without sending twice", async ({
  page,
}, info) => {
  const c = await open(page, "wallet-unknown", "transaction");
  await confirm(page).click();
  await expect(
    page.getByText("Status: unknown", { exact: true }),
  ).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  const saved = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(
        "artfi:nft:recovery:1:0x1111111111111111111111111111111111111111",
      )!,
    ),
  );
  expect(saved).toMatchObject({ id: c.state.operation!.id, attempted: true });
  await page.screenshot({
    path: info.outputPath("nft-native-unknown.png"),
    fullPage: true,
  });
  await page.reload();
  await recover(page).click();
  await expect(
    page.getByText("Status: unknown", { exact: true }),
  ).toBeVisible();
  await expect(confirm(page)).toBeDisabled();
  expect(c.state.start).toBe(1);
  expect(c.state.uncertain).toBe(1);
  await c.clean();
});
test("lost broadcast acknowledgement retains the original wallet hash for readonly recovery after reload", async ({
  page,
}) => {
  const c = await open(page, "broadcast-ack-lost", "transaction");
  await confirm(page).click();
  await expect(
    page.getByText("TEST_ONLY broadcast acknowledgement lost", { exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(
        "artfi:nft:recovery:1:0x1111111111111111111111111111111111111111",
      )!,
    ),
  );
  expect(saved.hash).toBe(hash);
  await page.reload();
  c.state.reconcile = true;
  await recover(page).click();
  await expect(
    page.getByText("Status: confirmed", { exact: true }),
  ).toBeVisible();
  expect(c.state.prepare).toBe(1);
  expect(c.state.start).toBe(1);
  expect(c.state.broadcast).toBe(2);
  await c.clean();
});
