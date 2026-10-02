import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  toFunctionSelector,
} from "viem";
import {
  artFiFractionMarketAbi,
  fractionTokenAbi,
  wholeArtworkMarketAbi,
} from "../src/lib/contracts";

const buyer = "0x1000000000000000000000000000000000000010";
const seller = "0x1000000000000000000000000000000000000020";
const paymentToken = "0x1000000000000000000000000000000000000005";
const collection = "0x1000000000000000000000000000000000000002";
const fraction = "0x1000000000000000000000000000000000000004";
const zero = "0x0000000000000000000000000000000000000000";
const hashes = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
const blockHash = `0x${"33".repeat(32)}`;

type Submitted = { to: string; data: `0x${string}` };
async function fixture(page: Page) {
  const state = {
    approve: "pending",
    fill: "pending",
    requests: [] as Submitted[],
    block: 100,
  };
  await page.addInitScript(
    ({ buyer, hashes }) => {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      let submitted = 0;
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(event: string, listener: (...args: unknown[]) => void) {
            (listeners[event] ||= []).push(listener);
          },
          removeListener() {},
          async request({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) {
            if (method === "eth_accounts" || method === "eth_requestAccounts")
              return [buyer];
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "wallet_requestPermissions")
              return [{ parentCapability: "eth_accounts" }];
            if (method === "eth_sendTransaction") {
              await fetch("/test-wallet-submit", {
                method: "POST",
                body: JSON.stringify(params?.[0]),
              });
              return hashes[submitted++];
            }
            throw new Error(`Unsupported test-wallet method: ${method}`);
          },
        },
      });
    },
    { buyer, hashes },
  );
  await page.route("**/test-wallet-submit", async (route) => {
    state.requests.push(route.request().postDataJSON());
    await route.fulfill({ body: "{}", contentType: "application/json" });
  });
  const selectors = Object.fromEntries(
    [
      "ownerOf(uint256)",
      "sellerEpoch(address)",
      "paused()",
      "allowedCollection(address)",
      "allowedAssetToken(address)",
      "allowedPaymentToken(address)",
      "balanceOf(address)",
      "allowance(address,address)",
      "intentFilled(bytes32)",
      "pilotPaymentCap(address,address)",
      "pilotPaymentUsed(address,address)",
      "isApprovedForAll(address,address)",
    ].map((signature) => [toFunctionSelector(signature), signature]),
  );
  await page.route("**/test-hoodi-rpc", async (route) => {
    const payload = route.request().postDataJSON();
    function contractResult(data: `0x${string}`): `0x${string}` {
      if (
        data.startsWith(
          toFunctionSelector("aggregate3((address,bool,bytes)[])"),
        )
      ) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3")
          throw new Error("Unexpected multicall fixture");
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: decoded.args[0].map((call) => ({
            success: true,
            returnData: contractResult(call.callData),
          })),
        });
      }
      const signature = selectors[data.slice(0, 10)];
      if (signature === "ownerOf(uint256)")
        return encodeAbiParameters([{ type: "address" }], [seller]);
      if (signature === "paused()")
        return encodeAbiParameters([{ type: "bool" }], [false]);
      if (
        signature?.startsWith("allowed") ||
        signature?.startsWith("isApproved")
      )
        return encodeAbiParameters([{ type: "bool" }], [true]);
      return encodeAbiParameters(
        [{ type: "uint256" }],
        [signature?.startsWith("pilotPaymentCap") ? 100000n : 0n],
      );
    }
    function result(request: {
      id: number;
      method: string;
      params: unknown[];
    }) {
      const { method, params } = request;
      let value: unknown;
      if (method === "eth_chainId") value = "0x88bb0";
      else if (method === "eth_blockNumber")
        value = `0x${(state.block++).toString(16)}`;
      else if (method === "eth_getBlockByNumber")
        value = {
          number: `0x${state.block.toString(16)}`,
          hash: blockHash,
          parentHash: blockHash,
          transactions: [],
          gasLimit: "0x1000000",
          gasUsed: "0x0",
          timestamp: "0x60000000",
          extraData: "0x",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          size: "0x1",
          uncles: [],
          miner: zero,
          nonce: "0x0000000000000000",
          mixHash: blockHash,
          receiptsRoot: blockHash,
          stateRoot: blockHash,
          transactionsRoot: blockHash,
          sha3Uncles: blockHash,
          logsBloom: `0x${"00".repeat(256)}`,
          baseFeePerGas: "0x1",
        };
      else if (method === "eth_getBalance") value = "0xde0b6b3a7640000";
      else if (method === "eth_call") {
        value = contractResult((params[0] as { data: `0x${string}` }).data);
      } else if (method === "eth_getTransactionReceipt") {
        const index = hashes.indexOf(String(params[0]));
        const outcome = index === 0 ? state.approve : state.fill;
        value =
          outcome === "pending"
            ? null
            : {
                transactionHash: params[0],
                transactionIndex: "0x0",
                blockHash,
                blockNumber: "0x64",
                from: buyer,
                to: state.requests[index]?.to,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                contractAddress: null,
                logs: [],
                logsBloom: `0x${"00".repeat(256)}`,
                status: outcome === "success" ? "0x1" : "0x0",
                effectiveGasPrice: "0x1",
                type: "0x2",
              };
      } else if (method === "eth_getTransactionByHash") {
        const index = hashes.indexOf(String(params[0]));
        value = {
          hash: params[0],
          from: buyer,
          to: state.requests[index]?.to,
          input: state.requests[index]?.data,
          nonce: `0x${index}`,
          value: "0x0",
          gas: "0x5208",
          gasPrice: "0x1",
          blockHash: null,
          blockNumber: null,
          transactionIndex: null,
          type: "0x2",
          chainId: "0x88bb0",
          v: "0x0",
          r: hashes[0],
          s: hashes[1],
        };
      } else
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Unsupported fixture RPC ${method}` },
        };
      return { jsonrpc: "2.0", id: request.id, result: value };
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(payload) ? payload.map(result) : result(payload),
      ),
    });
  });
  return state;
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page
    .getByRole("button", { name: /MetaMask|Injected/ })
    .first()
    .click();
  await expect(page.getByLabel("Seller's authorization")).toBeVisible();
}

function authorization(kind: "whole" | "fraction") {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    intent: {
      seller,
      paymentToken,
      buyer: zero,
      salt: "1",
      startsAt: now - 60,
      endsAt: now + 3600,
      epoch: "0",
      ...(kind === "whole"
        ? { collection, tokenId: "1", price: "123" }
        : { assetToken: fraction, maxAmount: "10", unitPrice: "41" }),
    },
    signature: `0x${"01".repeat(65)}`,
  });
}

for (const kind of ["whole", "fraction"] as const) {
  test(`${kind}: approval and settlement remain pending until successful receipts`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.goto(
      `/market/${kind === "whole" ? "rwa" : "fractionals"}/blue-hour-archive`,
    );
    await connect(page);
    await page.getByLabel("Seller's authorization").fill(authorization(kind));
    if (kind === "fraction")
      await page.getByLabel("Fractions to settle", { exact: true }).fill("3");
    await expect(
      page.getByText("Reading from chain", { exact: true }),
    ).toHaveCount(0);
    const button = page.getByRole("button", {
      name: kind === "whole" ? "Settle this sale" : "Settle this amount",
    });
    await button.click();
    await expect.poll(() => state.requests.length).toBe(1);
    const approval = decodeFunctionData({
      abi: fractionTokenAbi,
      data: state.requests[0].data,
    });
    expect(approval.functionName).toBe("approve");
    expect(approval.args?.[1]).toBe(123n);
    expect(state.requests[0].to.toLowerCase()).toBe(paymentToken);
    await expect(button).toBeDisabled();
    await expect(
      page.getByText("Settled on chain", { exact: true }),
    ).toHaveCount(0);
    state.approve = "success";
    await expect.poll(() => state.requests.length, { timeout: 20_000 }).toBe(2);
    const settled = decodeFunctionData({
      abi: kind === "whole" ? wholeArtworkMarketAbi : artFiFractionMarketAbi,
      data: state.requests[1].data,
    });
    expect(settled.functionName).toBe("fillIntent");
    await expect(
      page.getByText("Settled on chain", { exact: true }),
    ).toHaveCount(0);
    state.fill = "success";
    await expect(
      page.getByText("Settled on chain", { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });
}

test("a reverted approval never opens the settlement wallet request", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/market/rwa/blue-hour-archive");
  await connect(page);
  await page.getByLabel("Seller's authorization").fill(authorization("whole"));
  await expect(
    page.getByText("Reading from chain", { exact: true }),
  ).toHaveCount(0);
  state.approve = "reverted";
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect(page.getByText(/transaction reverted on chain/i)).toBeVisible({
    timeout: 20_000,
  });
  expect(state.requests).toHaveLength(1);
  await expect(page.getByText("Settled on chain", { exact: true })).toHaveCount(
    0,
  );
});

test("an unresolved fraction fill survives refresh and must be reconciled", async ({
  page,
}) => {
  const state = await fixture(page);
  state.approve = "success";
  await page.goto("/market/fractionals/blue-hour-archive");
  await connect(page);
  await page
    .getByLabel("Seller's authorization")
    .fill(authorization("fraction"));
  await page.getByLabel("Fractions to settle", { exact: true }).fill("3");
  await expect(
    page.getByText("Reading from chain", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settle this amount" }).click();
  await expect.poll(() => state.requests.length, { timeout: 20_000 }).toBe(2);
  await expect(
    page.getByText(hashes[1], { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Check transaction" }),
  ).toBeVisible();
  await page
    .getByLabel("Seller's authorization")
    .fill(authorization("fraction"));
  await page.getByLabel("Fractions to settle", { exact: true }).fill("3");
  await expect(
    page.getByRole("button", { name: "Settle this amount" }),
  ).toBeDisabled();
  expect(state.requests).toHaveLength(2);
  state.fill = "success";
  await page.getByRole("button", { name: "Check transaction" }).click();
  await expect(page.getByText("Settled on chain", { exact: true })).toBeVisible(
    { timeout: 20_000 },
  );
  expect(state.requests).toHaveLength(2);
});
