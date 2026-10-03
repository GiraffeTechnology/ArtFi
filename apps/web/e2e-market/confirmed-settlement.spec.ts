import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  toFunctionSelector,
} from "viem";
import {
  nativeOrderFromAuthorization,
  type NativeOrder,
} from "../src/lib/native-order";
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
async function fixture(page: Page, wallet = buyer) {
  const state = {
    approve: "pending",
    fill: "pending",
    requests: [] as Submitted[],
    block: 100,
    authenticated: true,
    used: false,
    validSignature: true,
    orders: [] as NativeOrder[],
    publications: [] as unknown[],
    signatures: [] as unknown[],
    holdPreflight: false,
    releasePreflight: undefined as (() => void) | undefined,
  };
  await page.addInitScript(
    ({ buyer, hashes }) => {
      let activeAccount = buyer;
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      let submitted = 0;
      // A fresh wallet has not authorized this origin yet. Persist only an explicit
      // connect request so reload tests exercise normal reconnect rather than auto-login.
      let authorized =
        window.sessionStorage.getItem("artfi-test-wallet-authorized") ===
        "true";
      const permit = () => {
        authorized = true;
        window.sessionStorage.setItem("artfi-test-wallet-authorized", "true");
        return [
          {
            parentCapability: "eth_accounts",
            caveats: [
              { type: "restrictReturnedAccounts", value: [activeAccount] },
            ],
          },
        ];
      };
      Object.defineProperty(window, "testChangeAccount", {
        value: (address: string) => {
          activeAccount = address;
          for (const listener of listeners.accountsChanged ?? [])
            listener([address]);
        },
      });
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
            if (method === "eth_accounts")
              return authorized ? [activeAccount] : [];
            if (method === "eth_requestAccounts") {
              permit();
              return [activeAccount];
            }
            if (method === "wallet_getPermissions")
              return authorized ? permit() : [];
            if (method === "wallet_revokePermissions") {
              authorized = false;
              window.sessionStorage.removeItem("artfi-test-wallet-authorized");
              return null;
            }
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "wallet_requestPermissions") return permit();
            if (method === "eth_signTypedData_v4") {
              await fetch("/test-wallet-sign", {
                method: "POST",
                body: JSON.stringify(params),
              });
              return `0x${"01".repeat(65)}`;
            }
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
    { buyer: wallet, hashes },
  );
  await page.route("**/test-wallet-submit", async (route) => {
    state.requests.push(route.request().postDataJSON());
    await route.fulfill({ body: "{}", contentType: "application/json" });
  });
  await page.route("**/test-wallet-sign", async (route) => {
    state.signatures.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });
  // Ordinary session boundary fixtures; the separate Next→Go integration suite exercises real cookies.
  await page.route("**/api/user/auth/*", async (route) => {
    if (route.request().url().endsWith("/logout")) {
      state.authenticated = false;
      await route.fulfill({ json: { ok: true } });
    } else if (!state.authenticated)
      await route.fulfill({ status: 401, json: { detail: "Sign in" } });
    else
      await route.fulfill({
        json: {
          session: {
            id: "test-only-session",
            address: wallet,
            chainId: 560048,
            expiresAt: 4_000_000_000_000,
            accessExpiresAt: 4_000_000_000_000,
          },
        },
      });
  });
  await page.route("**/api/orders**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      state.publications.push(body);
      if (!state.authenticated) {
        await route.fulfill({ status: 401, json: {} });
        return;
      }
      const order = body.order as NativeOrder;
      state.orders.push(order);
      await route.fulfill({ status: 201, json: order });
      return;
    }
    if (url.pathname !== "/api/orders") {
      const order = state.orders.find(
        (item) => item.intentHash === url.pathname.split("/").at(-1),
      );
      await route.fulfill({ status: order ? 200 : 404, json: order ?? {} });
      return;
    }
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const matched = state.orders.filter(
      (order) => order.kind === url.searchParams.get("kind"),
    );
    await route.fulfill({
      json: {
        data: matched.slice((pageNumber - 1) * 20, pageNumber * 20),
        total: matched.length,
        page: pageNumber,
        pageSize: 20,
      },
    });
  });
  const selectors = Object.fromEntries(
    [
      "ownerOf(uint256)",
      "getApproved(uint256)",
      "getEthBalance(address)",
      "intentUsed(bytes32)",
      "isValidSignature(bytes32,bytes)",
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
          result: decoded.args[0].map((call) => {
            try {
              return {
                success: true,
                returnData: contractResult(call.callData),
              };
            } catch {
              return { success: false, returnData: "0x" as const };
            }
          }),
        });
      }
      const signature = selectors[data.slice(0, 10)];
      if (!signature)
        throw new Error(`Unsupported fixture selector ${data.slice(0, 10)}`);
      if (signature === "isValidSignature(bytes32,bytes)") {
        const digest = data.slice(10, 74);
        const candidates = [
          nativeOrder("whole"),
          nativeOrder("fraction"),
          ...state.orders,
        ];
        const valid =
          state.validSignature &&
          candidates.some((order) => order.intentHash.slice(2) === digest);
        return `0x${valid ? "1626ba7e" : "ffffffff"}${"00".repeat(28)}`;
      }
      if (signature === "getEthBalance(address)")
        return encodeAbiParameters([{ type: "uint256" }], [10n ** 18n]);
      if (signature === "getApproved(uint256)")
        return encodeAbiParameters([{ type: "address" }], [zero]);
      if (signature === "intentUsed(bytes32)")
        return encodeAbiParameters([{ type: "bool" }], [state.used]);
      if (signature === "balanceOf(address)")
        return encodeAbiParameters(
          [{ type: "uint256" }],
          [
            data.toLowerCase().endsWith(seller.slice(2).toLowerCase())
              ? 10n
              : 0n,
          ],
        );
      if (signature === "allowance(address,address)")
        return encodeAbiParameters([{ type: "uint256" }], [10n]);
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
          timestamp: "0x5f5e1000",
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
      else if (method === "eth_getCode") value = "0x6000";
      else if (method === "eth_getBalance") value = "0xde0b6b3a7640000";
      else if (method === "eth_call") {
        try {
          value = contractResult((params[0] as { data: `0x${string}` }).data);
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: String(error) },
          };
        }
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
    const requests = Array.isArray(payload) ? payload : [payload];
    if (
      state.holdPreflight &&
      requests.some((request) => request.method === "eth_getCode")
    ) {
      await new Promise<void>((resolve) => {
        state.releasePreflight = resolve;
      });
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
  try {
    await page
      .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
      .first()
      .click({ timeout: 15_000 });
  } catch (error) {
    // Synthetic fixture diagnostics only: reveal the actual chooser/connection state.
    console.error(
      "Wallet chooser page state:",
      await page.locator("body").innerText(),
    );
    throw error;
  }
  await expect(
    page.getByText("Signed in", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
}

function authorization(kind: "whole" | "fraction", salt = "1") {
  const now = 1_600_000_000;
  return JSON.stringify(
    {
      intent: {
        seller,
        paymentToken,
        buyer: zero,
        salt,
        startsAt: now - 60,
        endsAt: now + 3600,
        epoch: "0",
        ...(kind === "whole"
          ? { collection, tokenId: "1", price: "123" }
          : { assetToken: fraction, maxAmount: "10", unitPrice: "41" }),
      },
      signature: `0x${"01".repeat(65)}`,
    },
    null,
    2,
  );
}

function nativeOrder(kind: "whole" | "fraction", salt = "1") {
  return nativeOrderFromAuthorization(
    kind,
    authorization(kind, salt),
    kind === "whole"
      ? "0x1000000000000000000000000000000000000001"
      : "0x1000000000000000000000000000000000000003",
  );
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

for (const kind of ["whole", "fraction"] as const) {
  test(`${kind}: rejects tampered signed terms before requesting approval`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.goto(
      `/market/${kind === "whole" ? "rwa" : "fractionals"}/blue-hour-archive`,
    );
    await connect(page);
    const altered = JSON.parse(authorization(kind));
    altered.intent[kind === "whole" ? "price" : "unitPrice"] = "999";
    await page
      .getByLabel("Seller's authorization")
      .fill(JSON.stringify(altered));
    if (kind === "fraction")
      await page.getByLabel("Fractions to settle", { exact: true }).fill("3");
    await page
      .getByRole("button", {
        name: kind === "whole" ? "Settle this sale" : "Settle this amount",
      })
      .click();
    await expect(
      page.getByText(/seller's signature is invalid/i),
    ).toBeVisible();
    expect(state.requests).toHaveLength(0);
  });

  test(`${kind}: restores exact public order links on reload and Back/Forward`, async ({
    page,
  }) => {
    if (kind === "fraction")
      await page.setViewportSize({ width: 390, height: 844 });
    const state = await fixture(page);
    state.orders = [nativeOrder(kind), nativeOrder(kind, "2")];
    await page.goto(
      `/market/${kind === "whole" ? "rwa" : "fractionals"}/blue-hour-archive?order=${state.orders[0].intentHash}`,
    );
    await connect(page);
    await expect(page.getByLabel("Seller's authorization")).toHaveValue(
      authorization(kind),
    );
    await page
      .getByRole("button", { name: "Load order", exact: true })
      .nth(1)
      .click();
    await expect(page).toHaveURL(new RegExp(state.orders[1].intentHash));
    await expect(page.getByLabel("Seller's authorization")).toHaveValue(
      authorization(kind, "2"),
    );
    await page.goBack();
    await expect(page.getByLabel("Seller's authorization")).toHaveValue(
      authorization(kind),
    );
    await page.goForward();
    await expect(page.getByLabel("Seller's authorization")).toHaveValue(
      authorization(kind, "2"),
    );
    await page.reload();
    await expect(page.getByLabel("Seller's authorization")).toHaveValue(
      authorization(kind, "2"),
    );
    // Normal hit testing must reach the wallet control below populated order cards.
    // Trial checks actionability without opening a wallet or submitting a transaction.
    await page
      .getByRole("button", {
        name: kind === "whole" ? "Settle this sale" : "Settle this amount",
      })
      .click({ trial: true });
    expect(state.requests).toHaveLength(0);
  });
}

test("current consumed state refuses approval even when the visible order was open", async ({
  page,
}) => {
  const state = await fixture(page);
  state.orders = [nativeOrder("whole")];
  await page.goto(
    `/market/rwa/blue-hour-archive?order=${state.orders[0].intentHash}`,
  );
  await connect(page);
  await expect(page.getByText(/Open authorization/)).toBeVisible();
  state.used = true;
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect(
    page.getByText(/already been settled or withdrawn/),
  ).toBeVisible();
  expect(state.requests).toHaveLength(0);
});

test("sale signing and explicit publication use the original signature and no transaction", async ({
  page,
}) => {
  const state = await fixture(page, seller);
  await page.goto("/market/rwa/blue-hour-archive");
  await connect(page);
  await page
    .getByLabel("Price, in the payment token's smallest unit")
    .fill("123");
  await page.getByLabel("Payment token", { exact: true }).fill(paymentToken);
  await page.getByRole("button", { name: "Sign the sale terms" }).click();
  await expect(
    page.getByRole("button", { name: "Publish sale terms", exact: true }),
  ).toBeVisible();
  expect(state.signatures).toHaveLength(1);
  expect(state.publications).toHaveLength(0);
  expect(state.requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Publish sale terms", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open the published order" }),
  ).toBeVisible();
  expect(state.publications).toHaveLength(1);
  expect(Object.keys(state.publications[0] as object)).toEqual(["order"]);
  expect(
    (state.publications[0] as { order: NativeOrder }).order.signature,
  ).toBe(`0x${"01".repeat(65)}`);
  expect(state.signatures).toHaveLength(1);
  expect(state.requests).toHaveLength(0);
});

test("pagination reaches the twenty-first FIFO order and exact links load outside page one", async ({
  page,
}) => {
  const state = await fixture(page);
  state.orders = Array.from({ length: 21 }, (_, index) =>
    nativeOrder("whole", String(index + 1)),
  );
  await page.goto("/market/rwa/blue-hour-archive");
  await expect(
    page.getByRole("button", { name: "Load order", exact: true }),
  ).toHaveCount(20);
  await page.getByRole("button", { name: "Next orders" }).click();
  await expect(
    page.getByRole("button", { name: "Load order", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText(state.orders[20].intentHash, { exact: true }),
  ).toBeVisible();
  await page.goto(
    `/market/rwa/blue-hour-archive?order=${state.orders[20].intentHash}`,
  );
  await connect(page);
  await expect(page.getByLabel("Seller's authorization")).toHaveValue(
    authorization("whole", "21"),
  );
});

test("unknown, malformed and wrong-asset links clear previously actionable terms", async ({
  page,
}) => {
  const state = await fixture(page);
  const valid = nativeOrder("whole");
  const otherAsset = JSON.parse(authorization("whole", "2"));
  otherAsset.intent.tokenId = "2";
  const wrong = nativeOrderFromAuthorization(
    "whole",
    JSON.stringify(otherAsset),
    valid.marketAddress,
  );
  state.orders = [valid, wrong];
  await page.goto(`/market/rwa/blue-hour-archive?order=${valid.intentHash}`);
  // A corrupt list is fail closed. Restrict to the valid list while retaining detail retrieval.
  await page.route("**/api/orders?**", (route) =>
    route.fulfill({ json: { data: [valid], total: 1, page: 1, pageSize: 20 } }),
  );
  await page.reload();
  await connect(page);
  await expect(page.getByLabel("Seller's authorization")).toHaveValue(
    authorization("whole"),
  );
  for (const hash of [`0x${"ab".repeat(32)}`, "malformed", wrong.intentHash]) {
    await page.evaluate((hash) => {
      history.pushState(null, "", `?order=${hash}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, hash);
    await expect(page.getByLabel("Seller's authorization")).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Settle this sale" }),
    ).toBeDisabled();
  }
  expect(state.requests).toHaveLength(0);
});

test("browser clock skew does not veto chain-valid sale terms", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.addInitScript(() => {
    Date.now = () => 1_900_000_000_000;
  });
  await page.goto("/market/rwa/blue-hour-archive");
  await connect(page);
  await page.getByLabel("Seller's authorization").fill(authorization("whole"));
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
});

test("account change during preflight retires the approval continuation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.holdPreflight = true;
  await page.goto("/market/rwa/blue-hour-archive");
  await connect(page);
  await page.getByLabel("Seller's authorization").fill(authorization("whole"));
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect.poll(() => Boolean(state.releasePreflight)).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { testChangeAccount: (address: string) => void }
    ).testChangeAccount("0x1000000000000000000000000000000000000030"),
  );
  state.releasePreflight?.();
  await expect(page.getByLabel("Seller's authorization")).toHaveValue("");
  expect(state.requests).toHaveLength(0);
});

test("an old fill receipt never marks a newly selected order as filled", async ({
  page,
}) => {
  const state = await fixture(page);
  state.approve = "success";
  state.orders = [nativeOrder("whole"), nativeOrder("whole", "2")];
  await page.goto(
    `/market/rwa/blue-hour-archive?order=${state.orders[0].intentHash}`,
  );
  await connect(page);
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect.poll(() => state.requests.length, { timeout: 20_000 }).toBe(2);
  await page
    .getByRole("button", { name: "Load order", exact: true })
    .nth(1)
    .click();
  await expect(page.getByLabel("Seller's authorization")).toHaveValue(
    authorization("whole", "2"),
  );
  state.fill = "success";
  await page.getByRole("button", { name: "Check transaction" }).click();
  await expect(
    page.getByRole("button", { name: "Check transaction" }),
  ).toHaveCount(0);
  await expect(page.getByText("Settled on chain", { exact: true })).toHaveCount(
    0,
  );
  expect(state.requests).toHaveLength(2);
});

test("logout during approval retires fill and retains read-only transaction checking", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/market/rwa/blue-hour-archive");
  await connect(page);
  await page.getByLabel("Seller's authorization").fill(authorization("whole"));
  await page.getByRole("button", { name: "Settle this sale" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check transaction" }),
  ).toBeEnabled();
  state.approve = "success";
  await page.getByRole("button", { name: "Check transaction" }).click();
  await expect(
    page.getByRole("button", { name: "Check transaction" }),
  ).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  await expect(page.getByText("Settled on chain", { exact: true })).toHaveCount(
    0,
  );
});
