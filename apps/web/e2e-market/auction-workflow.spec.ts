import { isolatedSourceCatalog } from "./rwa-catalog-fixture";
import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  encodeEventTopics,
  encodeAbiParameters,
  multicall3Abi,
  toFunctionSelector,
  zeroAddress,
  type Hex,
} from "viem";
import { auctionAbi, auctionTokenAbi } from "../src/lib/auction";
const buyer = "0x1000000000000000000000000000000000000010",
  seller = "0x1000000000000000000000000000000000000020",
  market = "0x1000000000000000000000000000000000000003",
  asset = "0x1000000000000000000000000000000000000004",
  payment = "0x1000000000000000000000000000000000000005";
const blockHash = `0x${"33".repeat(32)}` as Hex;
async function fixture(page: Page, wallet = buyer) {
  await isolatedSourceCatalog(page);
  const state = {
    block: 102,
    requests: [] as { to: string; data: Hex }[],
    confirmed: 0,
    timestamp: 1000,
    ends: 1100,
    paused: false,
    highest: 0n,
    bidder: zeroAddress as string,
    listingState: 1,
    credit: 0n,
    allowance: 0n,
    creation: null as null | { requestId: Hex; id: bigint },
    authenticated: true,
  };
  await page.addInitScript(
    ({ wallet }) => {
      let account = wallet,
        authorized = false;
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const permit = () => {
        authorized = true;
        return [
          {
            parentCapability: "eth_accounts",
            caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
          },
        ];
      };
      Object.defineProperty(window, "auctionChangeAccount", {
        value: (next: string) => {
          account = next;
          listeners.accountsChanged?.forEach((f) => f([next]));
        },
      });
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on: (event: string, fn: (...args: unknown[]) => void) => {
            (listeners[event] ||= []).push(fn);
          },
          removeListener() {},
          async request({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) {
            if (method === "eth_accounts") return authorized ? [account] : [];
            if (method === "eth_requestAccounts") {
              permit();
              return [account];
            }
            if (method === "wallet_requestPermissions") return permit();
            if (method === "wallet_getPermissions")
              return authorized ? permit() : [];
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "eth_sendTransaction") {
              const response = await fetch("/TEST_ONLY-auction-submit", {
                method: "POST",
                body: JSON.stringify(params?.[0]),
              });
              return (await response.json()).hash;
            }
            throw Error(`Unsupported isolated wallet method ${method}`);
          },
        },
      });
    },
    { wallet },
  );
  await page.route("**/TEST_ONLY-auction-submit", async (route) => {
    state.requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        hash: `0x${state.requests.length.toString(16).padStart(64, "0")}`,
      },
    });
  });
  await page.route("**/api/user/auth/*", async (route) => {
    if (!state.authenticated) {
      await route.fulfill({ status: 401, json: { detail: "Sign in" } });
      return;
    }
    await route.fulfill({
      json: {
        session: {
          id: "isolated-auction-session",
          address: wallet,
          chainId: 560048,
          expiresAt: 4000000000000,
          accessExpiresAt: 4000000000000,
        },
      },
    });
  });
  function contractResult(data: Hex): Hex {
    if (
      data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))
    ) {
      const decoded = decodeFunctionData({ abi: multicall3Abi, data });
      if (decoded.functionName !== "aggregate3") throw Error();
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: decoded.args[0].map((call) => {
          try {
            return { success: true, returnData: contractResult(call.callData) };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
    if (data.startsWith(toFunctionSelector("getEthBalance(address)")))
      return encodeAbiParameters([{ type: "uint256" }], [10n ** 18n]);
    const abi = [...auctionAbi, ...auctionTokenAbi];
    const decoded = decodeFunctionData({ abi, data }),
      name = decoded.functionName;
    const values: Record<string, unknown> = {
      listings: [
        wallet === seller ? seller : seller,
        asset,
        payment,
        10n,
        100n,
        900,
        state.ends,
        1,
        state.listingState,
        state.bidder,
        state.highest,
      ],
      auctionTerms: [120n, 5n, state.ends, 300, 300],
      paused: state.paused,
      balanceOf: 1000000n,
      pilotPaymentCap: 1000000n,
      pilotPaymentUsed: 0n,
      allowedPaymentToken: true,
      allowedAssetToken: true,
      credits: state.credit,
      allowance: state.allowance,
      symbol: "TEST",
      decimals: 0,
      approve: true,
    };
    // Simulations return no value and never mutate fixture state.
    if (
      ["placeBid", "settleAuction", "cancelListing", "withdrawCredit"].includes(
        name,
      )
    )
      return "0x";
    if (name === "createAuctionListing")
      return encodeAbiParameters([{ type: "uint256" }], [2n]);
    if (!(name in values)) throw Error(`Unsupported auction read ${name}`);
    return encodeFunctionResult({
      abi,
      functionName: name,
      result: values[name] as never,
    });
  }
  function confirm(index: number) {
    if (index <= state.confirmed) return;
    for (let i = state.confirmed; i < index; i++) {
      const decoded = decodeFunctionData({
        abi: [...auctionAbi, ...auctionTokenAbi],
        data: state.requests[i].data,
      });
      if (decoded.functionName === "approve") state.allowance = decoded.args[1];
      if (decoded.functionName === "placeBid") {
        state.highest = decoded.args[1];
        state.bidder = wallet;
        state.ends += 300;
      }
      if (decoded.functionName === "settleAuction") state.listingState = 2;
      if (decoded.functionName === "cancelListing") state.listingState = 3;
      if (decoded.functionName === "withdrawCredit") state.credit = 0n;
      if (decoded.functionName === "createAuctionListing") {
        state.creation = { requestId: decoded.args[0], id: 2n };
        state.ends = Number(decoded.args[6]);
      }
    }
    state.confirmed = index;
  }
  let receiptsReady = false;
  await page.route("**/test-hoodi-rpc", async (route) => {
    const response = (rpc: {
      id: number;
      method: string;
      params: unknown[];
    }) => {
      let result: unknown;
      const { method, params } = rpc;
      if (method === "eth_chainId") result = "0x88bb0";
      else if (method === "eth_blockNumber")
        result = `0x${(state.block++).toString(16)}`;
      else if (method === "eth_getBlockByNumber")
        result = {
          number: "0x66",
          hash: blockHash,
          parentHash: blockHash,
          transactions: [],
          gasLimit: "0x1000000",
          gasUsed: "0x0",
          timestamp: `0x${state.timestamp.toString(16)}`,
          extraData: "0x",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          size: "0x1",
          uncles: [],
          miner: zeroAddress,
          nonce: "0x0000000000000000",
          mixHash: blockHash,
          receiptsRoot: blockHash,
          stateRoot: blockHash,
          transactionsRoot: blockHash,
          sha3Uncles: blockHash,
          logsBloom: `0x${"00".repeat(256)}`,
          baseFeePerGas: "0x1",
        };
      else if (method === "eth_getLogs") result = [];
      else if (method === "eth_getCode") result = "0x6000";
      else if (method === "eth_getBalance") result = "0xde0b6b3a7640000";
      else if (method === "eth_call")
        result = contractResult((params[0] as { data: Hex }).data);
      else if (method === "eth_getTransactionReceipt") {
        const index = Number(BigInt(String(params[0])));
        if (!receiptsReady) result = null;
        else {
          confirm(index);
          const tx = state.requests[index - 1];
          const logs =
            state.creation && index === state.requests.length
              ? [
                  {
                    address: market,
                    topics: encodeEventTopics({
                      abi: auctionAbi,
                      eventName: "ListingCreated",
                      args: {
                        requestId: state.creation.requestId,
                        listingId: state.creation.id,
                        seller: wallet as `0x${string}`,
                      },
                    }),
                    data: "0x",
                    blockHash,
                    blockNumber: "0x64",
                    transactionHash: params[0],
                    transactionIndex: "0x0",
                    logIndex: "0x0",
                    removed: false,
                  },
                ]
              : [];
          result = {
            transactionHash: params[0],
            transactionIndex: "0x0",
            blockHash,
            blockNumber: "0x64",
            from: wallet,
            to: tx.to,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            contractAddress: null,
            logs,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            effectiveGasPrice: "0x1",
            type: "0x2",
          };
        }
      } else if (method === "eth_getTransactionByHash") {
        const index = Number(BigInt(String(params[0]))) - 1;
        result = {
          hash: params[0],
          from: wallet,
          to: state.requests[index]?.to,
          input: state.requests[index]?.data,
          nonce: `0x${index.toString(16)}`,
          value: "0x0",
          gas: "0x5208",
          gasPrice: "0x1",
          blockHash: null,
          blockNumber: null,
          transactionIndex: null,
          type: "0x2",
          chainId: "0x88bb0",
          v: "0x0",
          r: blockHash,
          s: blockHash,
        };
      } else
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Unsupported fixture RPC ${method}` },
        };
      return { jsonrpc: "2.0", id: rpc.id, result };
    };
    const data = route.request().postDataJSON();
    try {
      await route.fulfill({
        json: Array.isArray(data) ? data.map(response) : response(data),
      });
    } catch (error) {
      await route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: data.id,
          error: { code: -32601, message: String(error) },
        },
      });
    }
  });
  return {
    state,
    release: () => {
      receiptsReady = true;
    },
  };
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .first()
    .click();
  await expect(
    page.getByText("Signed in", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
}
const workbench = (page: Page) =>
  page.getByRole("region", { name: "On-chain fraction auctions" });
test("auction bid waits for allowance receipt, blocks repeat, then shows extended terms", async ({
  page,
}) => {
  const { state, release } = await fixture(page);
  await page.goto("/market/auctions");
  const ui = workbench(page);
  await ui.getByRole("button", { name: "Load auction", exact: true }).click();
  await expect(
    ui.getByRole("heading", { name: "Auction 1", exact: true }),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
  await expect(
    ui.getByRole("button", { name: "Review and place bid" }),
  ).toBeDisabled();
  await connect(page);
  await ui.getByRole("button", { name: "Load auction", exact: true }).click();
  await ui.getByLabel("Bid (TEST)").fill("125");
  await ui.getByRole("button", { name: "Review and place bid" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await expect(
    ui.getByRole("button", { name: "Review and place bid" }),
  ).toBeDisabled();
  expect(
    decodeFunctionData({ abi: auctionTokenAbi, data: state.requests[0].data })
      .functionName,
  ).toBe("approve");
  release();
  await expect.poll(() => state.requests.length, { timeout: 15000 }).toBe(2);
  await expect(
    ui.getByText(
      "Bid transaction confirmed. Refreshed auction terms and bid history are shown.",
    ),
  ).toBeVisible();
  await expect(ui.getByText(`Highest bid 125 TEST by ${buyer}`)).toBeVisible();
  expect(state.ends).toBe(1400);
});
test("paused auctions protect an active bid but allow ended settlement and credit withdrawal", async ({
  page,
}) => {
  const { state, release } = await fixture(page, seller);
  state.paused = true;
  state.highest = 150n;
  state.bidder = buyer;
  state.timestamp = 1200;
  state.credit = 77n;
  release();
  await page.goto("/market/auctions");
  await connect(page);
  const ui = workbench(page);
  await ui.getByRole("button", { name: "Load auction", exact: true }).click();
  await expect(
    ui.getByRole("button", { name: "Review and place bid" }),
  ).toBeDisabled();
  await expect(
    ui.getByRole("button", { name: "Cancel as seller" }),
  ).toBeDisabled();
  await ui.getByRole("button", { name: "Settle ended auction" }).click();
  await expect(
    ui.getByText("Auction settlement confirmed on chain."),
  ).toBeVisible();
  await ui.getByRole("button", { name: "Withdraw credit" }).click();
  await expect(
    ui.getByText("Credit withdrawal confirmed on chain."),
  ).toBeVisible();
  expect(
    state.requests.map(
      (tx) =>
        decodeFunctionData({ abi: auctionAbi, data: tx.data }).functionName,
    ),
  ).toEqual(["settleAuction", "withdrawCredit"]);
});
test("auction creation reviews exact escrow and expires private work on account change", async ({
  page,
}) => {
  const { state, release } = await fixture(page, seller);
  release();
  await page.goto("/market/auctions");
  await connect(page);
  const ui = workbench(page);
  await ui.getByText("Create a fraction auction", { exact: true }).click();
  await ui.getByLabel("Payment token address", { exact: true }).fill(payment);
  await ui.getByLabel("Fraction amount", { exact: true }).fill("10");
  await ui.getByLabel("Opening bid", { exact: true }).fill("100");
  await ui.getByLabel("Reserve", { exact: true }).fill("120");
  await ui.getByLabel("Minimum bid increment", { exact: true }).fill("5");
  await ui.getByRole("button", { name: "Review auction terms" }).click();
  await expect(
    ui.getByRole("region", { name: "Auction escrow review" }),
  ).toBeVisible();
  await expect(
    ui.getByRole("button", { name: "Confirm auction in wallet" }),
  ).toBeDisabled();
  await ui.getByLabel("I accept these bounded auction escrow terms.").check();
  await ui.getByRole("button", { name: "Confirm auction in wallet" }).click();
  await expect(
    ui.getByRole("heading", { name: "Auction 2", exact: true }),
  ).toBeVisible();
  expect(
    state.requests.map(
      (tx) =>
        decodeFunctionData({
          abi: [...auctionAbi, ...auctionTokenAbi],
          data: tx.data,
        }).functionName,
    ),
  ).toEqual(["approve", "createAuctionListing"]);
  await page.evaluate((buyer) => {
    (
      window as unknown as { auctionChangeAccount: (address: string) => void }
    ).auctionChangeAccount(buyer);
  }, buyer);
  await expect(
    ui.getByRole("heading", { name: "Auction 2", exact: true }),
  ).not.toBeVisible();
  await expect(
    ui.getByRole("region", { name: "Auction escrow review" }),
  ).not.toBeVisible();
});
