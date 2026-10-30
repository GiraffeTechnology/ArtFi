import { expect, test, type Page } from "@playwright/test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  zeroHash,
  type Hex,
} from "viem";

import { charityEditionsAbi } from "../src/lib/contracts";
import { supportedChain } from "../src/lib/wagmi";

/**
 * The populated rendering path.
 *
 * Explicit browser fixture, in the same sense as `market-unavailable.spec.ts`: the JSON-RPC
 * responses below are stubbed in the browser, so this proves **presentation**, not live chain
 * connectivity. It is here because the unavailable state is easy to test and the populated state is
 * the one that actually has to be right — a card that renders the wrong supply, or that silently
 * upgrades an empty distribution wallet to "sold out", would otherwise reach a reviewer unchecked.
 *
 * Nothing in the application changes to accommodate it. The page still reads the same contract
 * through the same client; only the transport is intercepted.
 */

const distributionWallet = "0x00000000000000000000000000000000000000a1";

const series = {
  artworkId: `0x${"11".repeat(32)}` as Hex,
  masterArtworkHash: `0x${"22".repeat(32)}` as Hex,
  metadataHash: `0x${"33".repeat(32)}` as Hex,
  distributionWallet: distributionWallet as Hex,
  createdAt: 1_760_000_000n,
  soldOutAt: 0n,
  physicalDonationRecordedAt: 0n,
  selloutEvidenceHash: zeroHash,
  physicalDonationEvidenceHash: zeroHash,
  metadataURI: "ipfs://charity/1",
};

function answer(data: Hex, count = 1n): Hex {
  const call = decodeFunctionData({ abi: charityEditionsAbi, data });
  switch (call.functionName) {
    case "seriesCount":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "seriesCount",
        result: count,
      });
    case "EDITIONS_PER_ARTWORK":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "EDITIONS_PER_ARTWORK",
        result: 100n,
      });
    case "PRIMARY_PRICE_WEI":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "PRIMARY_PRICE_WEI",
        result: 10_000_000_000_000_000n,
      });
    case "series":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "series",
        result: series,
      });
    case "totalSupply":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "totalSupply",
        result: 100n,
      });
    case "balanceOf":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "balanceOf",
        result: 63n,
      });
    default:
      throw new Error(`unexpected call ${call.functionName}`);
  }
}

/**
 * viem batches the page's parallel reads through Multicall3, so the stub has to speak it. Without
 * this the fixture would only ever exercise a single-read path the application does not take.
 */
const multicall3Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const call3Type = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;
const result3Type = [
  {
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  },
] as const;
const aggregate3Selector = "0x82ad56cb";

function answerCall(to: string | undefined, data: Hex, count = 1n): Hex {
  if (
    to?.toLowerCase() === multicall3Address.toLowerCase() &&
    data.startsWith(aggregate3Selector)
  ) {
    const [calls] = decodeAbiParameters(
      call3Type,
      `0x${data.slice(aggregate3Selector.length)}` as Hex,
    );
    return encodeAbiParameters(result3Type, [
      calls.map((call) => ({
        success: true,
        returnData: answer(call.callData, count),
      })),
    ]);
  }
  return answer(data, count);
}

type RpcRequest = { id: number; method: string; params?: unknown[] };

/** Answer the whole JSON-RPC conversation, not only `eth_call`: an unanswered probe hangs. */
function rpcResult(request: RpcRequest, count = 1n): unknown {
  switch (request.method) {
    case "eth_chainId":
      return `0x${supportedChain.id.toString(16)}`;
    case "eth_blockNumber":
      return "0x1";
    case "eth_getBlockByNumber":
      return {
        number: "0x1",
        hash: `0x${"aa".repeat(32)}`,
        parentHash: zeroHash,
        timestamp: `0x${(series.createdAt + 100n).toString(16)}`,
        nonce: "0x0000000000000000",
        difficulty: "0x0",
        totalDifficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        size: "0x1",
        baseFeePerGas: "0x1",
        extraData: "0x",
        logsBloom: `0x${"00".repeat(256)}`,
        miner: distributionWallet,
        mixHash: zeroHash,
        receiptsRoot: zeroHash,
        stateRoot: zeroHash,
        transactionsRoot: zeroHash,
        sha3Uncles: zeroHash,
        transactions: [],
        uncles: [],
      };
    case "eth_call": {
      const call = request.params?.[0] as { to?: string; data: Hex };
      return answerCall(call.to, call.data, count);
    }
    default:
      throw new Error(`unexpected RPC method ${request.method}`);
  }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const body = request.postData();
    if (request.method() !== "POST" || !body?.includes("jsonrpc")) {
      return route.fallback();
    }
    const payload = JSON.parse(body) as RpcRequest | RpcRequest[];
    const respond = (single: RpcRequest) => ({
      jsonrpc: "2.0",
      id: single.id,
      result: rpcResult(single),
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(respond) : respond(payload),
      ),
    });
  });
});

/**
 * Skipped unless an editions address is configured, because with none the catalog correctly reports
 * itself unavailable and there is nothing populated to assert. Run it with:
 *
 *   NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS=0x… pnpm --filter web test:e2e
 */
test("an edition renders the supply the contract reports", async ({ page }) => {
  test.skip(
    !process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS,
    "No editions address is configured for this run.",
  );
  await page.route("**/*", async (route) => {
    const request = route.request(),
      body = request.postData();
    if (request.method() !== "POST" || !body?.includes("jsonrpc"))
      return route.fallback();
    const payload = JSON.parse(body) as RpcRequest | RpcRequest[];
    const respond = (single: RpcRequest) => ({
      jsonrpc: "2.0",
      id: single.id,
      result: rpcResult(single, 21n),
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(respond) : respond(payload),
      ),
    });
  });
  await page.goto("/charity");
  await expect(page.locator(".charity-edition-card")).toHaveCount(20);
  const card = page.locator(".charity-edition-card").first();
  await expect(card).toContainText("Edition #1");
  await expect(card).toContainText("63 of 100");
  await expect(card).toContainText("Not recorded");
  await expect(page.getByTestId("charity-edition-terms")).toContainText(
    "0.01 ETH",
  );
  await page
    .getByRole("button", { name: "Next editions", exact: true })
    .click();
  await expect(page.locator(".charity-edition-card")).toHaveCount(1);
  await expect(page.locator(".charity-edition-card")).toContainText(
    "Edition #21",
  );
  await expect(
    page.getByRole("button", { name: "Next editions", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Previous editions", exact: true })
    .click();
  await expect(page.locator(".charity-edition-card")).toHaveCount(20);
  await expect(page.locator(".charity-edition-card").first()).toContainText(
    "Edition #1",
  );
});

// These failures remain explicit read-only transport fixtures. No wallet
// authorization, holder entitlement, transaction or live-chain claim follows.
const transportFailureMarker = "TEST_ONLY_UPSTREAM_DETAIL";
const transportFailureMessage =
  transportFailureMarker + " https://rpc.test.invalid/" + "x".repeat(12_000);

async function controlReadFailures(page: Page, control: { failing: boolean }) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const body = request.postData();
    if (request.method() !== "POST" || !body?.includes("jsonrpc")) {
      return route.fallback();
    }
    if (!control.failing) return route.fallback();
    const payload = JSON.parse(body) as RpcRequest | RpcRequest[];
    const respond = (single: RpcRequest) =>
      single.method === "eth_call"
        ? {
            jsonrpc: "2.0",
            id: single.id,
            error: { code: -32000, message: transportFailureMessage },
          }
        : { jsonrpc: "2.0", id: single.id, result: rpcResult(single) };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(respond) : respond(payload),
      ),
    });
  });
}

async function expectBoundedPublicError(page: Page) {
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(transportFailureMarker);
  expect(body).not.toContain("rpc.test.invalid");
  expect(body).not.toContain("Contract Call:");
  expect(body).not.toContain("Request body:");
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport + 1);
  await expect(page.getByTestId("charity-edition-rights-notice")).toBeVisible();
}

for (const surface of [
  {
    path: "/charity",
    errorId: "charity-catalog-read-error",
    ready: ".charity-edition-card",
    message: "The charity editions could not be read. Please retry.",
  },
  {
    path: "/charity/1",
    errorId: "charity-edition-read-error",
    ready: '[data-testid="charity-edition-facts"]',
    message: "This charity edition could not be read. Please retry.",
  },
]) {
  test(`charity read failures stay private and retry on ${surface.path}`, async ({
    page,
  }) => {
    test.skip(
      !process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS,
      "No editions address is configured for this run.",
    );
    const control = { failing: true };
    await controlReadFailures(page, control);
    await page.goto(surface.path);
    const error = page.getByTestId(surface.errorId);
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toContainText(surface.message);
    await expect(page.locator(surface.ready)).toHaveCount(0);
    await expectBoundedPublicError(page);
    control.failing = false;
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(surface.ready).first()).toBeVisible();
    await expect(error).toHaveCount(0);
    await expectBoundedPublicError(page);
  });
}

test("a failed charity refresh removes the earlier edition facts until recovery", async ({
  page,
}) => {
  test.skip(
    !process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS,
    "No editions address is configured for this run.",
  );
  const control = { failing: false };
  await controlReadFailures(page, control);
  await page.goto("/charity/1");
  const facts = page.getByTestId("charity-edition-facts");
  await expect(facts).toBeVisible();
  await expect(facts).toContainText("100");
  control.failing = true;
  await page
    .getByRole("button", { name: "Refresh edition facts", exact: true })
    .click();
  const error = page.getByTestId("charity-edition-read-error");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(facts).toHaveCount(0);
  await expectBoundedPublicError(page);
  control.failing = false;
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(facts).toBeVisible();
  await expect(facts).toContainText("100");
  await expect(error).toHaveCount(0);
  await expectBoundedPublicError(page);
});

test("a replaced charity facts block stays unavailable until a stable retry", async ({
  page,
}) => {
  test.skip(
    !process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS,
    "No editions address is configured for this run.",
  );
  let unstable = true;
  await page.route("**/*", async (route) => {
    const request = route.request(),
      body = request.postData();
    if (request.method() !== "POST" || !body?.includes("jsonrpc"))
      return route.fallback();
    const payload = JSON.parse(body) as RpcRequest | RpcRequest[];
    const respond = (single: RpcRequest) => {
      let result = rpcResult(single);
      if (
        unstable &&
        single.method === "eth_getBlockByNumber" &&
        single.params?.[0] !== "latest"
      )
        result = {
          ...(result as Record<string, unknown>),
          hash: `0x${"bb".repeat(32)}`,
        };
      return { jsonrpc: "2.0", id: single.id, result };
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(respond) : respond(payload),
      ),
    });
  });
  await page.goto("/charity/1");
  const error = page.getByTestId("charity-edition-read-error");
  await expect(error).toBeVisible();
  await expect(page.getByTestId("charity-edition-facts")).toHaveCount(0);
  await expect(page.getByTestId("charity-holder-access")).toHaveCount(0);
  await expectBoundedPublicError(page);
  unstable = false;
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("charity-edition-facts")).toBeVisible();
  await expect(page.getByTestId("charity-edition-facts")).toContainText("100");
  await expect(error).toHaveCount(0);
  await expectBoundedPublicError(page);
});
