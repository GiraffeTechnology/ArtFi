import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { encodeFunctionData, encodeFunctionResult } from "viem";
const multicallAddress = "0xcA11bde05977b3631167028862bE2a173976CA11";
const balanceAbi = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;
const aggregateAbi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "results",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

import type {} from "./fixtures/main";
test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed")
    console.log(
      "PORTFOLIO_QUERY_DIAGNOSTIC",
      JSON.stringify(
        await page.evaluate(() => window.portfolioFixture?.debug()),
      ),
    );
});

const origin = "https://portfolio-fixture.invalid";
const address = "0x6666666666666666666666666666666666666666";
type Mode = "success" | "error" | "hold" | "zero";
async function open(page: Page, options: { mode?: Mode; chain?: number } = {}) {
  const bundle = readFileSync(process.env.ARTFI_PORTFOLIO_FIXTURE!, "utf8");
  const css = readFileSync(
    process.env.ARTFI_PORTFOLIO_FIXTURE!.replace(/fixture\.js$/, "style.css"),
    "utf8",
  );
  const state = {
    mode: options.mode ?? ("success" as Mode),
    authenticated: false,
    rpc: [] as string[],
    blocked: [] as string[],
    releases: [] as (() => void)[],
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
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
                id: "TEST_ONLY-portfolio-session",
                address,
                chainId: options.chain ?? 560048,
                expiresAt: 4000000000000,
                accessExpiresAt: 4000000000000,
              }
            : null,
        },
      });
    }
    if (url.pathname === "/test-only-rpc") {
      const request = route.request().postDataJSON();
      const requests = Array.isArray(request) ? request : [request];
      const responses = [];
      for (const input of requests) {
        state.rpc.push(input.method);
        if (input.method === "eth_getBalance" || input.method === "eth_call") {
          if (input.method === "eth_getBalance")
            expect(input.params).toEqual([address, "latest"]);
          else {
            const callData = encodeFunctionData({
              abi: balanceAbi,
              functionName: "getEthBalance",
              args: [address],
            });
            const aggregate = encodeFunctionData({
              abi: aggregateAbi,
              functionName: "aggregate3",
              args: [
                [{ target: multicallAddress, allowFailure: true, callData }],
              ],
            });
            expect(input.params).toHaveLength(2);
            expect(input.params[0].to.toLowerCase()).toBe(
              multicallAddress.toLowerCase(),
            );
            expect(input.params[0].data).toBe(aggregate);
            expect(input.params[1]).toBe("latest");
          }
          if (state.mode === "hold")
            await new Promise<void>((resolve) => state.releases.push(resolve));
          if (state.mode === "error")
            responses.push({
              jsonrpc: "2.0",
              id: input.id,
              error: {
                code: -32000,
                message: "TEST_ONLY balance read unavailable",
              },
            });
          else {
            const value = state.mode === "zero" ? 0n : 123456700000000000000n;
            const result =
              input.method === "eth_getBalance"
                ? "0x" + value.toString(16)
                : encodeFunctionResult({
                    abi: aggregateAbi,
                    functionName: "aggregate3",
                    result: [
                      {
                        success: true,
                        returnData: `0x${value.toString(16).padStart(64, "0")}`,
                      },
                    ],
                  });
            responses.push({ jsonrpc: "2.0", id: input.id, result });
          }
        } else if (input.method === "eth_chainId")
          responses.push({
            jsonrpc: "2.0",
            id: input.id,
            result: "0x" + BigInt(options.chain ?? 560048).toString(16),
          });
        else if (input.method === "eth_blockNumber")
          responses.push({ jsonrpc: "2.0", id: input.id, result: "0x1" });
        else {
          state.blocked.push(input.method);
          responses.push({
            jsonrpc: "2.0",
            id: input.id,
            error: { code: -32601, message: "TEST_ONLY method refused" },
          });
        }
      }
      return route.fulfill({
        json: Array.isArray(request) ? responses : responses[0],
      });
    }
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>',
      });
    state.blocked.push(url.pathname);
    return route.abort();
  });
  page.on("pageerror", (error) =>
    console.log("PORTFOLIO_PAGE_ERROR", error.message),
  );
  await page.goto(origin + "/" + (options.chain === 1 ? "?network=1" : ""));
  await page
    .getByRole("button", { name: "Connect TEST_ONLY wallet", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText(
    `connected:${options.chain ?? 560048}`,
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
  const release = () => {
    for (const resolve of state.releases.splice(0)) resolve();
  };
  return { state, restore, release };
}
async function viewport(page: Page) {
  const box = page.viewportSize()!;
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  console.log(
    "PORTFOLIO_VIEWPORT",
    JSON.stringify({
      project: test.info().project.name,
      viewport: box,
      layout,
    }),
  );
  expect(layout.width).toBe(box.width);
  expect(layout.document).toBeLessThanOrEqual(box.width);
}
const balance = (page: Page) =>
  page
    .locator(".wallet-facts > div")
    .filter({ has: page.getByText("Test ETH", { exact: true }) });

test("a real connected Wagmi mock connector does not read balances without the matching HTTP session", async ({
  page,
}) => {
  const f = await open(page);
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  expect(
    f.state.rpc.filter((x) => x === "eth_getBalance" || x === "eth_call"),
  ).toHaveLength(0);
  expect(f.state.blocked).toEqual([]);
});
test("a held real query shows loading, then the balance and full address fit each viewport", async ({
  page,
}) => {
  const f = await open(page, { mode: "hold" });
  await f.restore();
  await expect
    .poll(
      () =>
        f.state.rpc.filter((x) => x === "eth_getBalance" || x === "eth_call")
          .length,
    )
    .toBe(1);
  await expect(balance(page)).toContainText("Loading");
  f.state.mode = "success";
  f.release();
  await expect(balance(page)).toContainText("123.4567");
  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await viewport(page);
  await page.screenshot({
    path: test.info().outputPath("portfolio-balance-ready.png"),
    fullPage: true,
  });
  expect(f.state.blocked).toEqual([]);
});
test("an initial RPC error becomes unavailable and a user retry recovers the same read-only query", async ({
  page,
}) => {
  const f = await open(page, { mode: "error" });
  await f.restore();
  await expect(page.getByRole("alert")).toContainText("balance is unavailable");
  await expect(balance(page)).toContainText("Unavailable");
  await expect(balance(page)).not.toContainText("0.0000");
  await viewport(page);
  await page.screenshot({
    path: test.info().outputPath("balance-error.png"),
    fullPage: true,
  });
  f.state.mode = "success";
  await page
    .getByRole("button", { name: "Retry balance", exact: true })
    .click();
  await expect(balance(page)).toContainText("123.4567");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    f.state.rpc.filter((x) => x === "eth_getBalance" || x === "eth_call")
      .length,
  ).toBeGreaterThanOrEqual(2);
  expect(f.state.blocked).toEqual([]);
});
test("a failed refetch hides stale balance and recovery can report an actual zero", async ({
  page,
}) => {
  const f = await open(page);
  await f.restore();
  await expect(balance(page)).toContainText("123.4567");
  f.state.mode = "error";
  await page
    .getByRole("button", { name: "Refresh TEST_ONLY balance", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("balance is unavailable");
  await expect(balance(page)).not.toContainText("123.4567");
  await viewport(page);
  await page.screenshot({
    path: test.info().outputPath("balance-stale-hidden.png"),
    fullPage: true,
  });
  f.state.mode = "zero";
  await page
    .getByRole("button", { name: "Retry balance", exact: true })
    .click();
  await expect(balance(page)).toContainText("0.0000");
  expect(f.state.blocked).toEqual([]);
});
test("disconnecting removes the real query's cached balance immediately", async ({
  page,
}) => {
  const f = await open(page);
  await f.restore();
  await expect(balance(page)).toContainText("123.4567");
  await page
    .getByRole("button", { name: "Disconnect TEST_ONLY wallet", exact: true })
    .click();
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  await expect(page.getByText("123.4567", { exact: true })).toHaveCount(0);
  expect(f.state.blocked).toEqual([]);
});
test("switching the real mock connector's chain removes the prior session balance", async ({
  page,
}) => {
  const f = await open(page);
  await f.restore();
  await expect(balance(page)).toContainText("123.4567");
  await page
    .getByRole("button", { name: "Switch TEST_ONLY chain", exact: true })
    .click();
  await expect(page.getByTestId("real-wallet-state")).toHaveText("connected:1");
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  await expect(page.getByText("123.4567", { exact: true })).toHaveCount(0);
  expect(f.state.blocked).toEqual([]);
});
test("an authenticated unsupported network does not pretend a balance request is loading", async ({
  page,
}) => {
  const f = await open(page, { chain: 1 });
  await f.restore();
  await expect(balance(page)).toContainText("Unavailable on this network");
  await viewport(page);
  await page.screenshot({
    path: test.info().outputPath("balance-unsupported.png"),
    fullPage: true,
  });
  expect(
    f.state.rpc.filter((x) => x === "eth_getBalance" || x === "eth_call"),
  ).toHaveLength(0);
  expect(f.state.blocked).toEqual([]);
});
test("ending the HTTP session removes the cached balance", async ({ page }) => {
  const f = await open(page);
  await f.restore();
  await expect(balance(page)).toContainText("123.4567");
  await page
    .getByRole("button", { name: "End TEST_ONLY session", exact: true })
    .click();
  await expect(page.getByTestId("portfolio-wallet-gate")).toBeVisible();
  await expect(page.getByText("123.4567", { exact: true })).toHaveCount(0);
  expect(f.state.blocked).toEqual([]);
});
