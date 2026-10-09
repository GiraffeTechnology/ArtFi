import { test, expect, type Page } from "@playwright/test";

const account = "0x1111111111111111111111111111111111111111";
const scope = {
  slug: "test-only-digital",
  chain: "ethereum",
  contract: "0x2222222222222222222222222222222222222222",
  standard: "erc1155",
  label: "TEST ONLY digital edition",
  charity: true,
};
const token = {
  tokenId: "7",
  name: "TEST ONLY edition seven",
  contract: scope.contract,
  standard: scope.standard,
  collection: scope.slug,
};
const hash = `0x${"7".repeat(64)}`;
function recordedOperation(id: string, tokenId: string, status = "accepted") {
  return {
    id,
    status,
    walletStarted: true,
    orderHash: hash,
    updatedAt: "2026-10-06T00:00:00Z",
    plan: {
      id: `TEST_ONLY-plan-${tokenId}`,
      operationId: id,
      sessionId: "TEST_ONLY-session",
      chainId: 1,
      request: {
        action: "list",
        collection: scope.slug,
        tokenId,
        account,
        quantity: "1",
        priceWei: "10000000000000000",
        expiresAt: 4000000000,
      },
      scope,
      expiresAt: 4000000000000,
      kind: "signature",
      summary: `TEST ONLY recorded listing for edition ${tokenId}.`,
      fees: [],
      orderHash: hash,
    },
  };
}
async function fixture(page: Page) {
  const state = {
    authenticated: true,
    preparations: 0,
    planKind: "signature" as "signature" | "approval" | "transaction",
    orders: [] as {
      hash: string;
      side: "listing" | "offer";
      maker: string;
      quantity: string;
      priceWei: string;
      currency: string;
      expiresAt: number;
      status: string;
    }[],
    preparedRequests: [] as Record<string, unknown>[],
    transactions: [] as Record<string, unknown>[],
    receiptStatus: "broadcast" as "broadcast" | "confirmed",
    loseBroadcastResponse: false,
    signatures: 0,
    submissions: 0,
    status: "awaiting-wallet",
    operation: null as Record<string, unknown> | null,
    failCatalog: false,
    changeReview: false,
    failPrepare: false,
    loseWalletStartResponse: false,
    historyOperations: {} as Record<
      string,
      ReturnType<typeof recordedOperation>
    >,
    historyPages: [] as number[],
    statusRequests: [] as string[],
  };
  await page.addInitScript(
    ({ account }) => {
      let authorized = false;
      let selectedAccount = account;
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      window.addEventListener("TEST_ONLY-nft-wallet-account", (event) => {
        selectedAccount = (event as CustomEvent<string>).detail;
        listeners.accountsChanged?.forEach((listener) =>
          listener([selectedAccount]),
        );
      });
      const permissions = () => [
        {
          parentCapability: "eth_accounts",
          caveats: [
            { type: "restrictReturnedAccounts", value: [selectedAccount] },
          ],
        },
      ];
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(event: string, fn: (...args: unknown[]) => void) {
            (listeners[event] ||= []).push(fn);
          },
          removeListener(event: string, fn: (...args: unknown[]) => void) {
            listeners[event] = (listeners[event] || []).filter(
              (listener) => listener !== fn,
            );
          },
          async request({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) {
            if (method === "eth_accounts")
              return authorized ? [selectedAccount] : [];
            if (method === "eth_requestAccounts") {
              authorized = true;
              return [selectedAccount];
            }
            if (method === "wallet_getPermissions")
              return authorized ? permissions() : [];
            if (method === "wallet_requestPermissions") {
              authorized = true;
              return permissions();
            }
            if (method === "wallet_revokePermissions") {
              authorized = false;
              return null;
            }
            if (method === "eth_chainId") return "0x1";
            if (method === "wallet_getCapabilities") return {};
            if (method === "eth_sendTransaction") {
              await fetch("/TEST_ONLY-nft-transaction", {
                method: "POST",
                body: JSON.stringify(params),
              });
              return `0x${"ab".repeat(32)}`;
            }
            if (method === "eth_signTypedData_v4") {
              await fetch("/TEST_ONLY-nft-signature", {
                method: "POST",
                body: JSON.stringify(params),
              });
              return `0x${"01".repeat(65)}`;
            }
            throw new Error(`Unexpected isolated wallet request ${method}`);
          },
        },
      });
    },
    { account },
  );
  await page.route("**/TEST_ONLY-nft-transaction", async (route) => {
    state.transactions.push(route.request().postDataJSON()[0]);
    await route.fulfill({ json: {} });
  });
  await page.route("**/TEST_ONLY-nft-signature", async (route) => {
    state.signatures++;
    await route.fulfill({ json: {} });
  });
  await page.route("**/TEST_ONLY-nft-rpc", async (route) => {
    const raw = route.request().postDataJSON();
    const result = (query: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: query.id,
      result:
        query.method === "eth_chainId"
          ? "0x1"
          : query.method === "eth_getBalance"
            ? "0x0"
            : "0x64",
    });
    await route.fulfill({
      json: Array.isArray(raw) ? raw.map(result) : result(raw),
    });
  });
  await page.route("**/api/user/auth/*", async (route) => {
    if (route.request().url().endsWith("logout")) {
      state.authenticated = false;
      await route.fulfill({ json: { ok: true } });
    } else
      await route.fulfill(
        state.authenticated
          ? {
              json: {
                session: {
                  id: "TEST_ONLY-session",
                  address: account,
                  chainId: 1,
                  expiresAt: 4000000000000,
                  accessExpiresAt: 4000000000000,
                },
              },
            }
          : { status: 401, json: { detail: "Sign in" } },
      );
  });
  await page.route("**/api/nft/**", async (route) => {
    const url = new URL(route.request().url()),
      action = url.pathname.split("/").pop();
    if (action === "config") {
      await route.fulfill({
        json: { collections: [scope], tradingEnabled: true },
      });
      return;
    }
    if (action === "catalog") {
      await route.fulfill(
        state.failCatalog
          ? {
              status: 429,
              json: {
                detail: "OpenSea is rate-limiting requests. Try again later.",
              },
            }
          : { json: { data: [token], next: null } },
      );
      return;
    }
    if (action === "owned") {
      await route.fulfill(
        state.authenticated
          ? {
              json: {
                wallet: account,
                chainId: 1,
                data: [{ ...token, name: "TEST ONLY private owned edition" }],
                next: null,
                observedAt: new Date().toISOString(),
              },
            }
          : { status: 401, json: { detail: "Sign in" } },
      );
      return;
    }
    if (action === "detail") {
      await route.fulfill({
        json: {
          nft: token,
          scope,
          orders: state.orders,
          ordersUnavailable: false,
          observedAt: new Date().toISOString(),
        },
      });
      return;
    }
    if (action === "history") {
      const page = Number(url.searchParams.get("page") || 1);
      state.historyPages.push(page);
      const records = Object.values(state.historyOperations);
      await route.fulfill(
        state.authenticated
          ? {
              json: {
                wallet: account,
                chainId: 1,
                page,
                pageSize: 25,
                hasMore: records.length > page * 25,
                data: records
                  .slice((page - 1) * 25, page * 25)
                  .map((entry) => ({
                    id: entry.id,
                    chainId: entry.plan.chainId,
                    status: entry.status,
                    action: entry.plan.request.action,
                    collection: entry.plan.request.collection,
                    tokenId: entry.plan.request.tokenId,
                    kind: entry.plan.kind,
                    walletStarted: entry.walletStarted,
                    orderHash: entry.orderHash,
                    updatedAt: entry.updatedAt,
                  })),
              },
            }
          : { status: 401, json: { detail: "Sign in" } },
      );
      return;
    }
    const body = route.request().postDataJSON();
    if (action === "status") {
      state.statusRequests.push(body.operationId);
      if (state.historyOperations[body.operationId]) {
        await route.fulfill({
          json: state.historyOperations[body.operationId],
        });
        return;
      }
    }
    if (action === "prepare") {
      state.preparations++;
      state.preparedRequests.push(body.request);
      if (state.failPrepare) {
        await route.fulfill({
          status: 422,
          json: { detail: "TEST ONLY preparation rejected" },
        });
        return;
      }
      state.status = "awaiting-wallet";
      state.operation = {
        id: body.operationId,
        status: state.status,
        plan: {
          id: "TEST_ONLY-plan",
          operationId: body.operationId,
          sessionId: "TEST_ONLY-session",
          chainId: 1,
          request: body.request,
          scope,
          expiresAt: Date.now() + 120000,
          kind: state.planKind,
          ...(state.planKind === "signature"
            ? {}
            : {
                transaction: {
                  to:
                    state.planKind === "approval"
                      ? scope.contract
                      : "0x0000000000000068F116a894984e2DB1123eB395",
                  data: "0x12345678",
                  value:
                    state.planKind === "transaction" &&
                    body.request.action === "buy"
                      ? body.request.priceWei
                      : "0",
                },
              }),
          summary: "Sign a TEST ONLY listing for one isolated edition.",
          fees: [],
          orderHash: hash,
          typedData: {
            domain: {
              name: "Seaport",
              version: "1.6",
              chainId: 1,
              verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
            },
            types: {
              OrderComponents: [
                { name: "offerer", type: "address" },
                { name: "tokenId", type: "uint256" },
              ],
            },
            primaryType: "OrderComponents",
            message: { offerer: account, tokenId: "7" },
          },
        },
      };
    }
    if (action === "review" && state.changeReview) {
      await route.fulfill({
        json: {
          ...state.operation,
          plan: {
            ...(state.operation!.plan as object),
            summary: "Changed unreviewed terms",
          },
        },
      });
      return;
    }
    if (action === "wallet-start") {
      state.operation = { ...state.operation, walletStarted: true };
      if (state.loseWalletStartResponse) {
        await route.fulfill({
          status: 503,
          json: { detail: "TEST ONLY wallet start response unavailable" },
        });
        return;
      }
    }
    if (action === "wallet-rejected" || action === "wallet-uncertain") {
      state.operation = {
        ...state.operation,
        status: action === "wallet-rejected" ? "rejected" : "failed",
      };
    }
    if (action === "broadcast") {
      state.operation = {
        ...state.operation,
        status: state.receiptStatus,
        transactionHash: body.transactionHash,
      };
      if (state.loseBroadcastResponse) {
        await route.fulfill({
          status: 503,
          json: { detail: "TEST ONLY broadcast acknowledgement lost" },
        });
        return;
      }
    }
    if (action === "sign") {
      state.submissions++;
      state.status = "accepted";
      state.operation = {
        ...state.operation,
        status: "accepted",
        orderHash: hash,
      };
    }
    if (action === "abandon") {
      state.status = "cancelled";
      state.operation = { ...state.operation, status: "cancelled" };
    }
    if (!state.operation) {
      await route.fulfill({ status: 404, json: { detail: "No operation" } });
      return;
    }
    await route.fulfill({ json: state.operation });
  });
  return state;
}
async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .first()
    .click();
  await expect(
    page.getByText("Signed in", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
}
test("native offer uses the reviewed signature contract without a transaction", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page.getByRole("button", { name: "Make offer", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toContainText("WETH");
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect(
    page.getByText(
      "OpenSea accepted the order. This does not confirm settlement.",
    ),
  ).toBeVisible();
  expect(state.preparedRequests[0].action).toBe("offer");
  expect(state.signatures).toBe(1);
  expect(state.transactions).toHaveLength(0);
});
for (const action of ["buy", "accept", "cancel"] as const) {
  test(`native ${action} binds its exact order and recovers a lost receipt acknowledgement without resending`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.planKind = "transaction";
    state.orders.push({
      hash,
      side: action === "accept" ? "offer" : "listing",
      maker:
        action === "cancel"
          ? account
          : "0x3333333333333333333333333333333333333333",
      quantity: "2",
      priceWei: "20000000000000000",
      currency: action === "accept" ? "WETH" : "ETH",
      expiresAt: 4000000000,
      status: "open",
    });
    await page.goto("/nft");
    await connect(page);
    await page
      .getByRole("button", { name: "Inspect NFT", exact: true })
      .click();
    await page
      .getByRole("button", {
        name:
          action === "buy"
            ? "Buy"
            : action === "accept"
              ? "Accept offer"
              : "Cancel order on chain",
        exact: true,
      })
      .click();
    expect(state.preparedRequests[0].action).toBe(action);
    expect(state.preparedRequests[0].orderHash).toBe(hash);
    expect(state.preparedRequests[0].quantity).toBe(
      action === "cancel" ? "2" : "1",
    );
    state.loseBroadcastResponse = true;
    await page
      .getByRole("button", { name: "Confirm in wallet", exact: true })
      .click();
    await expect.poll(() => state.transactions.length).toBe(1);
    await expect(
      page.getByText("TEST ONLY broadcast acknowledgement lost", {
        exact: true,
      }),
    ).toBeVisible();
    expect(state.transactions[0].to?.toString().toLowerCase()).toBe(
      "0x0000000000000068f116a894984e2db1123eb395",
    );
    expect(BigInt(String(state.transactions[0].value))).toBe(
      action === "buy" ? 10000000000000000n : 0n,
    );
    state.loseBroadcastResponse = false;
    state.receiptStatus = "confirmed";
    await page.reload();
    await connect(page);
    await page
      .getByRole("button", { name: "Check / recover operation", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Wallet action review" }),
    ).toContainText("Status: confirmed");
    expect(state.transactions).toHaveLength(1);
    expect(state.signatures).toBe(0);
  });
}
test("an approval receipt enables a fresh signing review without falsely publishing an order", async ({
  page,
}) => {
  const state = await fixture(page);
  state.planKind = "approval";
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toContainText("This approval does not publish an order");
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect.poll(() => state.transactions.length).toBe(1);
  expect(BigInt(String(state.transactions[0].value))).toBe(0n);
  expect(state.submissions).toBe(0);
  expect(state.signatures).toBe(0);
  state.receiptStatus = "confirmed";
  await page
    .getByRole("button", { name: "Check / recover operation", exact: true })
    .click();
  await expect(
    page.getByText(
      "Approval confirmed. Prepare the same action again to review the next step.",
    ),
  ).toBeVisible();
  state.planKind = "signature";
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect.poll(() => state.signatures).toBe(1);
  expect(state.preparations).toBe(2);
  expect(state.transactions).toHaveLength(1);
});
test("native discovery stays in ArtFi and protected actions require a real session", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/nft");
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create listing", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(/no copyright, physical title/).first(),
  ).toBeVisible();
  await expect(page.locator('main a[href*="opensea.io"]')).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "NFT marketplace", exact: true })
      .locator("img"),
  ).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/nft");
});
test("native listing reviews, signs once and distinguishes venue acceptance from settlement", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect(
    page.getByText(
      "OpenSea accepted the order. This does not confirm settlement.",
    ),
  ).toBeVisible();
  expect(state.preparations).toBe(1);
  expect(state.signatures).toBe(1);
  expect(state.submissions).toBe(1);
  await expect(
    page.getByRole("button", { name: "Confirm in wallet", exact: true }),
  ).toBeDisabled();
});
test("changed review terms never reach the wallet", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  state.changeReview = true;
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect(
    page.getByText(/NFT review, wallet or chain changed/),
  ).toBeVisible();
  expect(state.signatures).toBe(0);
  expect(state.submissions).toBe(0);
});
test("closing a review preserves recovery and sign-out immediately removes private review data", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Check / recover operation", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Check / recover operation",
      exact: true,
    }),
  ).toHaveCount(0);
});
test("upstream errors are visible and retry restores the native catalogue", async ({
  page,
}) => {
  const state = await fixture(page);
  state.failCatalog = true;
  await page.goto("/nft");
  await expect(page.getByText(/OpenSea is rate-limiting/)).toBeVisible();
  state.failCatalog = false;
  await page
    .getByRole("button", { name: "Refresh collections", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect NFT", exact: true }),
  ).toBeVisible();
});

test("a rejected preparation without a journal record can be safely cleared and retried", async ({
  page,
}) => {
  const state = await fixture(page);
  state.failPrepare = true;
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(page.getByText("TEST ONLY preparation rejected")).toBeVisible();
  await page
    .getByRole("button", { name: "Check / recover operation", exact: true })
    .click();
  await expect(
    page.getByText(
      "No saved wallet operation was found. You can prepare a new review.",
    ),
  ).toBeVisible();
  state.failPrepare = false;
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Wallet action review" }),
  ).toBeVisible();
  expect(state.preparations).toBe(2);
  expect(state.signatures).toBe(0);
});
test("an uncertain wallet start cannot be overwritten by another preparation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseWalletStartResponse = true;
  await page.goto("/nft");
  await connect(page);
  await page.getByRole("button", { name: "Inspect NFT", exact: true }).click();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm in wallet", exact: true })
    .click();
  await expect(
    page.getByText("TEST ONLY wallet start response unavailable"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create listing", exact: true })
    .click();
  await expect(
    page.getByText(/Finish or discard the previous review/),
  ).toBeVisible();
  expect(state.preparations).toBe(1);
  await page
    .getByRole("button", { name: "Check / recover operation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm in wallet", exact: true }),
  ).toBeDisabled();
  expect(state.signatures).toBe(0);
  await page
    .getByRole("button", {
      name: "Discard unsubmitted signature review",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/The unsubmitted signature review was discarded/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish this review", exact: true }),
  ).toBeVisible();
});

test("venue-indexed NFT holdings require sign-in and disappear immediately on sign-out", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/nft");
  const panel = page.getByRole("region", {
    name: "My venue-indexed NFTs",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: "Load my NFT holdings" }),
  ).toBeDisabled();
  await connect(page);
  await panel.getByRole("button", { name: "Load my NFT holdings" }).click();
  await expect(
    panel.getByText(/TEST ONLY private owned edition/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    panel.getByText(/TEST ONLY private owned edition/),
  ).not.toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Load my NFT holdings" }),
  ).toBeDisabled();
});

test("private NFT history pages select recorded operations and recover their current status", async ({
  page,
}) => {
  const state = await fixture(page);
  for (let index = 0; index < 26; index++) {
    const id = `TEST_ONLY-history-operation-${index}`;
    state.historyOperations[id] = recordedOperation(id, String(index + 7));
  }
  await page.goto("/nft");
  const history = page.getByRole("region", {
    name: "My NFT operation history",
    exact: true,
  });
  const load = history.getByRole("button", { name: "Load my NFT operations" });
  await expect(load).toBeDisabled();
  expect(state.historyPages).toEqual([]);
  await connect(page);
  await load.click();
  await expect(history.getByRole("listitem")).toHaveCount(25);
  await expect(history.getByText("Page 1", { exact: true })).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Previous NFT operations" }),
  ).toBeDisabled();
  await expect(
    history.getByText(/venue acceptance is not confirmation of settlement/),
  ).toBeVisible();
  await history.getByRole("button", { name: "Next NFT operations" }).click();
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Next NFT operations" }),
  ).toBeDisabled();
  await history
    .getByRole("button", { name: "Previous NFT operations" })
    .click();
  await expect(history.getByRole("listitem")).toHaveCount(25);
  const first = history.getByRole("listitem").first();
  await expect(first).toContainText("token 7");
  await first
    .getByRole("button", { name: "Recover this NFT operation" })
    .click();
  const review = page.getByRole("region", { name: "Wallet action review" });
  await expect(
    review.getByText("TEST ONLY recorded listing for edition 7."),
  ).toBeVisible();
  await expect(
    review.getByText("Status: accepted", { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Confirm in wallet" }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Close review", exact: true })
    .click();
  await expect(review).toHaveCount(0);
  state.historyOperations["TEST_ONLY-history-operation-0"].status = "cancelled";
  await page.getByRole("button", { name: "Check / recover operation" }).click();
  await expect(
    review.getByText("Status: cancelled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Operation status: cancelled.", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => state.statusRequests)
    .toEqual([
      "TEST_ONLY-history-operation-0",
      "TEST_ONLY-history-operation-0",
    ]);
  await history
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: "Recover this NFT operation" })
    .click();
  await expect(
    review.getByText("TEST ONLY recorded listing for edition 8."),
  ).toBeVisible();
  await expect(
    review.getByText("Status: accepted", { exact: true }),
  ).toBeVisible();
  expect(state.statusRequests.at(-1)).toBe("TEST_ONLY-history-operation-1");
  expect(state.historyPages).toEqual([1, 2, 1]);
  expect(state.preparations).toBe(0);
  expect(state.signatures).toBe(0);
  expect(state.submissions).toBe(0);
});

for (const change of ["sign-out", "wallet switch"] as const) {
  test(`private NFT history and its recovered review clear on ${change}`, async ({
    page,
  }) => {
    const state = await fixture(page);
    const id = "TEST_ONLY-history-operation-7";
    state.historyOperations[id] = recordedOperation(id, "7");
    await page.goto("/nft");
    await connect(page);
    const history = page.getByRole("region", {
      name: "My NFT operation history",
      exact: true,
    });
    await history
      .getByRole("button", { name: "Load my NFT operations" })
      .click();
    await expect(history.getByRole("listitem")).toHaveCount(1);
    await history
      .getByRole("button", { name: "Recover this NFT operation" })
      .click();
    await expect(
      page.getByRole("region", { name: "Wallet action review" }),
    ).toBeVisible();
    if (change === "sign-out") {
      await page
        .getByRole("button", { name: "Sign out", exact: true })
        .filter({ visible: true })
        .click();
    } else {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("TEST_ONLY-nft-wallet-account", {
            detail: "0x3333333333333333333333333333333333333333",
          }),
        );
      });
    }
    await expect(history.getByRole("listitem")).toHaveCount(0);
    await expect(
      history.getByRole("button", { name: "Load my NFT operations" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Wallet action review" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check / recover operation" }),
    ).toHaveCount(0);
    expect(state.signatures).toBe(0);
    expect(state.submissions).toBe(0);
  });
}
