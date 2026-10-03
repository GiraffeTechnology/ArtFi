import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { erc721VaultApprovalAbi, vaultFactoryAbi } from "../src/lib/contracts";
import {
  createSetupChainFixture,
  setupAddresses as addresses,
  setupMetadataHash,
  setupMetadataUri,
  setupRequestIds,
} from "../src/test/setup-chain-fixture";

type Boundary =
  "upload" | "mint-intent" | "vault-intent" | "wallet" | "submission";
type WalletResult = "accept" | "reject" | "unknown";

async function setupFixture(page: Page) {
  const chain = createSetupChainFixture();
  const state = {
    chain,
    account: addresses.wallet as Address,
    walletResults: [] as WalletResult[],
    walletRequests: [] as Array<{ to: Address; data: Hex; from: Address }>,
    uploads: [] as unknown[],
    uploadBodies: 0,
    mintIntents: [] as Array<{
      key: string | undefined;
      body: Record<string, unknown>;
    }>,
    vaultIntents: [] as Array<{
      key: string | undefined;
      body: Record<string, unknown>;
    }>,
    submissions: [] as Array<{ kind: string; hash: Hex }>,
    submissionStatus: 200,
    operatorAuthenticated: true,
    operatorSessionStatus: 200,
    hold: undefined as Boundary | undefined,
    release: undefined as (() => void) | undefined,
    released: false,
    vaultOverrides: {} as Record<string, unknown>,
    mintOverrides: {} as Record<string, unknown>,
  };
  const pause = async (boundary: Boundary) => {
    if (state.hold !== boundary) return;
    await new Promise<void>((resolve) => {
      state.release = () => {
        state.hold = undefined;
        resolve();
      };
    });
    state.released = true;
  };
  // Nothing in these tests may reach an external wallet, API, RPC, or real asset.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  await page.addInitScript(
    ({ wallet }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      let account: string = wallet;
      let authorized =
        sessionStorage.getItem("artfi-setup-test-authorized") === "true";
      const permit = () => {
        authorized = true;
        sessionStorage.setItem("artfi-setup-test-authorized", "true");
        return [
          {
            parentCapability: "eth_accounts",
            caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
          },
        ];
      };
      Object.defineProperty(window, "artfiSetupFixture", {
        value: {
          change(next: string) {
            account = next;
            listeners.accountsChanged?.forEach((listener) => listener([next]));
          },
        },
      });
      Object.defineProperty(window, "ethereum", {
        value: {
          isMetaMask: true,
          on(event: string, listener: (...args: unknown[]) => void) {
            (listeners[event] ||= []).push(listener);
          },
          removeListener(
            event: string,
            listener: (...args: unknown[]) => void,
          ) {
            listeners[event] =
              listeners[event]?.filter((value) => value !== listener) ?? [];
          },
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
            if (method === "wallet_revokePermissions") {
              authorized = false;
              sessionStorage.removeItem("artfi-setup-test-authorized");
              return null;
            }
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "personal_sign") return `0x${"11".repeat(65)}`;
            if (method === "eth_sendTransaction") {
              const response = await fetch("/test-setup-wallet", {
                method: "POST",
                body: JSON.stringify(params?.[0]),
              });
              const result = await response.json();
              if (result.error)
                throw Object.assign(new Error(result.error.message), {
                  code: result.error.code,
                });
              return result.hash;
            }
            throw new Error(`Unsupported TEST_ONLY wallet request: ${method}`);
          },
        },
      });
    },
    { wallet: addresses.wallet },
  );
  await page.route("**/test-setup-wallet", async (route) => {
    const input = route.request().postDataJSON();
    state.walletRequests.push(input);
    await pause("wallet");
    const outcome = state.walletResults.shift() ?? "accept";
    if (outcome !== "accept")
      return route.fulfill({
        json: {
          error: {
            code: outcome === "reject" ? 4001 : -32000,
            message:
              outcome === "reject"
                ? "TEST_ONLY user rejected the wallet request"
                : "TEST_ONLY wallet connection lost before transaction hash returned",
          },
        },
      });
    await route.fulfill({ json: { hash: chain.submit(input) } });
  });
  await page.route("**/test-hoodi-rpc", async (route) => {
    const input = route.request().postDataJSON();
    await route.fulfill({
      json: Array.isArray(input) ? input.map(chain.rpc) : chain.rpc(input),
    });
  });
  await page.route("**/api/user/auth/*", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "TEST_ONLY-session",
          address: state.account,
          chainId: 560048,
          expiresAt: 4_000_000_000_000,
          accessExpiresAt: 4_000_000_000_000,
        },
      },
    }),
  );
  await page.route("**/api/operator/auth/session", (route) =>
    route.fulfill({
      status: state.operatorSessionStatus,
      json: {
        authenticated: state.operatorAuthenticated,
        address: state.account,
        ...(state.operatorSessionStatus === 401
          ? { detail: "TEST_ONLY no operator cookie" }
          : {}),
      },
    }),
  );
  await page.route("**/api/operator/auth/challenge", (route) =>
    route.fulfill({
      json: { address: state.account, message: "TEST_ONLY operator challenge" },
    }),
  );
  await page.route("**/api/operator/auth/verify", (route) => {
    state.operatorAuthenticated = true;
    state.operatorSessionStatus = 200;
    return route.fulfill({
      json: { authenticated: true, address: state.account },
    });
  });
  await page.route("**/v1/config", (route) =>
    route.fulfill({
      json: {
        chainId: 560048,
        network: "hoodi",
        registryAddress: addresses.registry,
        vaultFactoryAddress: addresses.factory,
      },
    }),
  );
  await page.route("**/v1/nfts?**", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            standard: "ERC-721",
            collectionAddress: addresses.collection,
            tokenId: "1",
            holderAddress: addresses.wallet,
            recipient: addresses.wallet,
            name: "TEST_ONLY Recovery NFT",
          },
        ],
        chainId: 560048,
        runtime: true,
        total: 1,
        page: 1,
        pageSize: 100,
      },
    }),
  );
  await page.route("**/api/operator/v1/uploads/intents", async (route) => {
    state.uploads.push(route.request().postDataJSON());
    await pause("upload");
    const id = `TEST-ONLY-upload-${state.uploads.length}`;
    await route.fulfill({
      status: 201,
      json: { uploadId: id, uploadUrl: `/v1/uploads/${id}` },
    });
  });
  await page.route(
    "**/api/operator/v1/uploads/TEST-ONLY-upload-*",
    async (route) => {
      state.uploadBodies++;
      await route.fulfill({ json: { completed: true } });
    },
  );
  const mintIntent = () => ({
    intentId: "TEST-ONLY-mint-intent",
    requestId: setupRequestIds.mint,
    recipient: addresses.wallet,
    registryAddress: addresses.registry,
    chainId: 560048,
    metadataUri: setupMetadataUri,
    metadataSha256: setupMetadataHash,
    status: "prepared",
    ...state.mintOverrides,
  });
  const vaultIntent = () => ({
    intentId: "TEST-ONLY-vault-intent",
    requestId: setupRequestIds.vault,
    factoryAddress: addresses.factory,
    collectionAddress: addresses.collection,
    tokenId: "1",
    vaultName: "TEST_ONLY Recovery DAO",
    adminAddress: addresses.wallet,
    pauserAddress: addresses.wallet,
    fractionalizerAddress: addresses.wallet,
    chainId: 560048,
    status: "prepared",
    ...state.vaultOverrides,
  });
  for (const kind of ["rwa", "vault"] as const) {
    await page.route(`**/api/operator/v1/${kind}/intents`, async (route) => {
      const requests = kind === "rwa" ? state.mintIntents : state.vaultIntents;
      const value = {
        key: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON(),
      };
      const conflict = requests.some(
        (entry) =>
          entry.key === value.key &&
          JSON.stringify(entry.body) !== JSON.stringify(value.body),
      );
      requests.push(value);
      await pause(kind === "rwa" ? "mint-intent" : "vault-intent");
      await route.fulfill(
        conflict
          ? {
              status: 409,
              json: {
                detail:
                  "TEST_ONLY idempotency key reused for different payload",
              },
            }
          : {
              status: 201,
              json: kind === "rwa" ? mintIntent() : vaultIntent(),
            },
      );
    });
    await page.route(
      `**/api/operator/v1/${kind}/intents/TEST-ONLY-*-intent`,
      (route) =>
        route.fulfill({ json: kind === "rwa" ? mintIntent() : vaultIntent() }),
    );
    await page.route(
      `**/api/operator/v1/${kind}/intents/TEST-ONLY-*-intent/submission`,
      async (route) => {
        state.submissions.push({
          kind,
          hash: route.request().postDataJSON().transactionHash,
        });
        await pause("submission");
        return route.fulfill({
          status: state.submissionStatus,
          json:
            state.submissionStatus === 200
              ? { status: "submitted" }
              : { detail: "TEST_ONLY submission record unavailable" },
        });
      },
    );
  }
  return state;
}

type Fixture = Awaited<ReturnType<typeof setupFixture>>;
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
    page.locator(".wallet-button--connected").filter({ visible: true }),
  ).toBeVisible();
}
async function switchWallet(page: Page, state: Fixture, address: Address) {
  state.account = address;
  await page.evaluate((next) => {
    (
      window as unknown as {
        artfiSetupFixture: { change: (address: string) => void };
      }
    ).artfiSetupFixture.change(next);
  }, address);
}
async function openMint(page: Page) {
  await page.goto("/create/rwa");
  await connect(page);
  await expect(
    page.getByRole("button", { name: "Administrator wallet verified" }),
  ).toBeVisible();
  await page
    .getByLabel("Work title", { exact: true })
    .fill("TEST_ONLY Recovery Artwork");
  await page.getByLabel("Artist or maker").fill("TEST_ONLY Maker");
  await page.getByLabel("Year", { exact: true }).fill("2026");
  await page
    .getByLabel("Medium", { exact: true })
    .fill("TEST_ONLY digital fixture");
  await page
    .getByLabel("Location", { exact: true })
    .fill("TEST_ONLY isolated browser");
  await page
    .getByLabel("Description", { exact: true })
    .fill(
      "TEST_ONLY synthetic artwork for isolated transaction recovery verification.",
    );
  await page.getByLabel("Rights-cleared image").setInputFiles({
    name: "TEST_ONLY-recovery.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
}
async function openVault(page: Page, continuation = false) {
  await page.goto(
    continuation
      ? `/dao?chainId=560048&collectionAddress=${addresses.collection}&tokenId=1`
      : "/dao",
  );
  await connect(page);
  await expect(
    page.getByRole("button", { name: "Operator wallet verified", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("ERC-721 collection", { exact: true })
    .fill(addresses.collection);
  await page.getByLabel("Token ID", { exact: true }).fill("1");
  await page.getByLabel("Vault / DAO name").fill("TEST_ONLY Recovery DAO");
  await page.getByLabel("Fraction token name").fill("TEST_ONLY Fractions");
  await page.getByLabel("Symbol", { exact: true }).fill("TEST");
  await page.getByLabel("Whole-token supply").fill("100");
}
const mintButton = (page: Page) =>
  page.getByRole("button", { name: "Review and mint on Hoodi", exact: true });
const vaultButton = (page: Page) =>
  page.getByRole("button", { name: "Step 1 · Create Vault", exact: true });
const approveButton = (page: Page) =>
  page.getByRole("button", {
    name: "Step 2 · Approve this token only",
    exact: true,
  });
const depositButton = (page: Page) =>
  page.getByRole("button", {
    name: "Step 3 · Deposit into Vault",
    exact: true,
  });
const issueButton = (page: Page) =>
  page.getByRole("button", {
    name: "Step 4 · Issue fixed fractions",
    exact: true,
  });

test("rejected mint preserves the prepared upload and intent on explicit retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await setupFixture(page);
  state.walletResults = ["reject", "accept"];
  await openMint(page);
  await mintButton(page).click();
  const retry = page.getByRole("button", {
    name: "Retry prepared mint",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  expect(state.uploads).toHaveLength(1);
  expect(state.uploadBodies).toBe(1);
  expect(state.mintIntents).toHaveLength(1);
  await retry.click();
  await expect(
    page.getByRole("heading", { name: "Mint confirmed on Hoodi" }),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(2);
  expect(state.chain.state.transactions).toHaveLength(1);
  expect(state.uploads).toHaveLength(1);
  expect(state.mintIntents).toHaveLength(1);
  expect(state.chain.state.unknownCalls).toEqual([]);
  const continuation = page.getByRole("link", {
    name: "Continue to Vault and DAO verification →",
  });
  await expect(continuation).toHaveAttribute(
    "href",
    `/dao?chainId=560048&collectionAddress=${addresses.collection}&tokenId=1`,
  );
  await continuation.click();
  await expect(
    page.getByLabel("ERC-721 collection", { exact: true }),
  ).toHaveValue(addresses.collection);
  await expect(page.getByLabel("Token ID", { exact: true })).toHaveValue("1");
  await expect(
    page.getByRole("button", { name: "Find my owned NFTs", exact: true }),
  ).toBeVisible();
});

for (const kind of ["mint", "vault"] as const) {
  test(`${kind}: a late submission response cannot mark a remounted view as logged`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.hold = "submission";
    await (kind === "mint" ? openMint(page) : openVault(page));
    await (kind === "mint" ? mintButton(page) : vaultButton(page)).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await expect(
      kind === "mint"
        ? page.getByRole("heading", {
            name: "Mint confirmed on Hoodi",
            exact: true,
          })
        : page.getByText(`Vault: ${addresses.vault}`, { exact: true }),
    ).toBeVisible();

    // The application Link keeps the original fetch alive across SPA departure.
    // Back mounts a fresh view of the same durable public setup journal.
    await page
      .getByRole("link", { name: "ArtCCH TM: ArtFi home", exact: true })
      .click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(kind === "mint" ? /\/create\/rwa$/ : /\/dao$/);
    const retry = page.getByRole("button", {
      name:
        kind === "mint"
          ? "Retry submission record"
          : "Retry submission logging",
      exact: true,
    });
    await expect(retry).toBeVisible();
    const response = page.waitForResponse(
      (value) => value.url().endsWith("/submission") && value.status() === 200,
    );
    state.release!();
    await response;
    await expect(retry).toBeEnabled();
    const saved = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)!),
      `artfi:setup:${kind}:560048:${addresses.wallet}`,
    );
    if (kind === "mint") {
      expect(saved.data.loggedHash).toBeUndefined();
      await expect(
        page.getByText("Transaction submission recorded by the API.", {
          exact: true,
        }),
      ).toHaveCount(0);
    } else expect(saved.data.submissionPending).toBe(true);
    expect(state.submissions).toHaveLength(1);

    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(state.submissions).toHaveLength(2);
    expect(state.walletRequests).toHaveLength(1);
  });

  test(`${kind}: a late wallet hash remains with the departed wallet's recovery journal`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.hold = "wallet";
    await (kind === "mint" ? openMint(page) : openVault(page));
    await (kind === "mint" ? mintButton(page) : vaultButton(page)).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await switchWallet(page, state, addresses.otherWallet);
    await expect(
      page.locator(".wallet-button--connected").first(),
    ).toContainText("0020");
    state.release!();
    await expect.poll(() => state.chain.state.transactions.length).toBe(1);
    const hash = state.chain.state.transactions[0].hash;
    await expect(
      page.locator(`a[href="https://hoodi.etherscan.io/tx/${hash}"]`),
    ).toHaveCount(0);
    await switchWallet(page, state, addresses.wallet);
    const check = page.getByRole("button", {
      name: kind === "mint" ? "Check mint transaction" : "Check transaction",
      exact: true,
    });
    await expect(check).toBeEnabled();
    await check.click();
    await expect(
      kind === "mint"
        ? page.getByRole("heading", { name: "Mint confirmed on Hoodi" })
        : approveButton(page),
    ).toBeVisible();
    expect(state.walletRequests).toHaveLength(1);
  });

  test(`${kind}: repeated submit events during preparation create one operation`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.hold = kind === "mint" ? "upload" : "vault-intent";
    await (kind === "mint" ? openMint(page) : openVault(page));
    await page.locator("form.rwa-form").evaluate((form) => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await expect(
      kind === "mint" ? mintButton(page) : vaultButton(page),
    ).toBeDisabled();
    expect(kind === "mint" ? state.uploads : state.vaultIntents).toHaveLength(
      1,
    );
    state.release!();
    await expect.poll(() => state.walletRequests.length).toBe(1);
    await expect(
      kind === "mint"
        ? page.getByRole("heading", { name: "Mint confirmed on Hoodi" })
        : approveButton(page),
    ).toBeVisible();
    expect(state.walletRequests).toHaveLength(1);
  });

  test(`${kind}: wallet change while preparation is awaiting an API response never signs`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.hold = kind === "mint" ? "mint-intent" : "vault-intent";
    await (kind === "mint" ? openMint(page) : openVault(page));
    await (kind === "mint" ? mintButton(page) : vaultButton(page)).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await switchWallet(page, state, addresses.otherWallet);
    await expect(
      page.locator(".wallet-button--connected").first(),
    ).toContainText("0020");
    state.release!();
    await expect.poll(() => state.released).toBe(true);
    // Switching back exposes the original settled operation lease, making the
    // absence of a late old-wallet continuation observable without a timed sleep.
    await switchWallet(page, state, addresses.wallet);
    await expect(
      kind === "mint" ? mintButton(page) : vaultButton(page),
    ).toBeEnabled();
    expect(state.walletRequests).toHaveLength(0);
  });

  test(`${kind}: a wallet error without a hash remains blocked after reload`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.walletResults = ["unknown"];
    await (kind === "mint" ? openMint(page) : openVault(page));
    await (kind === "mint" ? mintButton(page) : vaultButton(page)).click();
    await expect(
      page
        .getByText(/no known transaction hash|wallet request is unresolved/)
        .first(),
    ).toBeVisible();
    await page.reload();
    const check = page.getByRole("button", {
      name: kind === "mint" ? "Check mint transaction" : "Check transaction",
      exact: true,
    });
    await expect(check).toBeEnabled();
    await expect(
      kind === "mint" ? mintButton(page) : vaultButton(page),
    ).toBeDisabled();
    await check.click();
    await expect(check).toBeEnabled();
    await expect(
      kind === "mint" ? mintButton(page) : vaultButton(page),
    ).toBeDisabled();
    expect(state.walletRequests).toHaveLength(1);
    expect(state.chain.state.transactions).toHaveLength(0);
  });

  test(`${kind}: known-hash recovery stays read-only while API config and authentication are unavailable`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    const action = kind === "mint" ? "mint" : "create";
    state.chain.state.outcomes[action] = "pending";
    await (kind === "mint" ? openMint(page) : openVault(page));
    await (kind === "mint" ? mintButton(page) : vaultButton(page)).click();
    await expect.poll(() => state.chain.state.transactions.length).toBe(1);
    await page.route("**/v1/config", (route) =>
      route.fulfill({
        status: 503,
        json: { detail: "TEST_ONLY config unavailable" },
      }),
    );
    await page.route("**/api/operator/auth/session", (route) =>
      route.fulfill({
        status: 503,
        json: { detail: "TEST_ONLY auth unavailable" },
      }),
    );
    await page.reload();
    const check = page.getByRole("button", {
      name: kind === "mint" ? "Check mint transaction" : "Check transaction",
      exact: true,
    });
    await expect(check).toBeEnabled();
    state.chain.state.outcomes[action] = "success";
    await check.click();
    await expect(
      page.getByRole("heading", {
        name: kind === "mint" ? "Mint confirmed on Hoodi" : "Vault created",
        exact: true,
      }),
    ).toBeVisible();
    expect(state.walletRequests).toHaveLength(1);
    expect(state.chain.state.transactions).toHaveLength(1);
  });
}

test("mint hash survives failed submission logging and refresh without a second broadcast", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.submissionStatus = 503;
  state.chain.state.outcomes.mint = "pending";
  await openMint(page);
  await mintButton(page).click();
  await expect.poll(() => state.chain.state.transactions.length).toBe(1);
  const original = state.chain.state.transactions[0].hash;
  await expect(
    page.locator(`a[href="https://hoodi.etherscan.io/tx/${original}"]`),
  ).toBeVisible();
  await page.reload();
  const check = page.getByRole("button", {
    name: "Check mint transaction",
    exact: true,
  });
  await expect(check).toBeEnabled();
  await expect(mintButton(page)).toBeDisabled();
  state.chain.state.outcomes.mint = "success";
  await check.click();
  await expect(
    page.getByRole("heading", { name: "Mint confirmed on Hoodi" }),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(1);
  state.submissionStatus = 200;
  await page
    .getByRole("button", { name: "Retry submission record", exact: true })
    .click();
  await expect(
    page.getByText("Transaction submission recorded by the API.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.submissions.every((entry) => entry.hash === original)).toBe(
    true,
  );
});

test("vault no-event replay and failed logging retain the same vault across Back and reload", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.submissionStatus = 503;
  state.chain.state.noCreationEvents = true;
  await openVault(page, true);
  await vaultButton(page).click();
  await expect(approveButton(page)).toBeEnabled();
  await expect(
    page.getByText(`Vault: ${addresses.vault}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry submission logging" }),
  ).toBeEnabled();
  await page.goto("/");
  await page.goBack();
  await expect(page).toHaveURL(/\/dao(?:\?|$)/);
  await expect(approveButton(page)).toBeEnabled();
  await page.reload();
  await expect(approveButton(page)).toBeEnabled();
  await expect(vaultButton(page)).toBeDisabled();
  await expect(
    page.getByText(`Vault: ${addresses.vault}`, { exact: true }),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(1);
  state.submissionStatus = 200;
  await page.getByRole("button", { name: "Retry submission logging" }).click();
  await expect(
    page.getByRole("button", { name: "Retry submission logging" }),
  ).toHaveCount(0);
  expect(state.chain.state.unknownCalls).toEqual([]);
});

test("vault approval, deposit and issuance each recover their original pending hash", async ({
  page,
}) => {
  const state = await setupFixture(page);
  await openVault(page);
  await vaultButton(page).click();
  await expect(approveButton(page)).toBeEnabled();
  for (const [action, button, next] of [
    ["approve", approveButton, depositButton],
    ["deposit", depositButton, issueButton],
    ["issue", issueButton, undefined],
  ] as const) {
    state.chain.state.outcomes[action] = "pending";
    const before = state.walletRequests.length;
    await button(page).click();
    await expect.poll(() => state.walletRequests.length).toBe(before + 1);
    await page.reload();
    const check = page.getByRole("button", {
      name: "Check transaction",
      exact: true,
    });
    await expect(check).toBeEnabled();
    await expect(button(page)).toBeDisabled();
    state.chain.state.outcomes[action] = "success";
    await check.click();
    if (next) await expect(next(page)).toBeEnabled();
    else
      await expect(
        page.getByRole("heading", {
          name: "DAO asset setup confirmed",
          exact: true,
        }),
      ).toBeVisible();
    expect(state.walletRequests).toHaveLength(before + 1);
  }
  const approval = state.chain.state.transactions.find(
    (entry) => entry.action === "approve",
  )!;
  const call = decodeFunctionData({
    abi: erc721VaultApprovalAbi,
    data: approval.data,
  });
  expect(call.functionName).toBe("approve");
  expect(call.args).toEqual([addresses.vault, 1n]);
  await expect(page.getByRole("link", { name: /holdings/i })).toHaveAttribute(
    "href",
    new RegExp(addresses.fraction, "i"),
  );
  expect(state.chain.state.unknownCalls).toEqual([]);
});

test("a reverted exact-token approval leaves deposit unavailable and permits deliberate retry", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.chain.state.outcomes.approve = "reverted";
  await openVault(page);
  await vaultButton(page).click();
  await approveButton(page).click();
  await expect(page.locator(".dao-create").getByRole("alert")).toContainText(
    "reverted on chain",
  );
  await expect(approveButton(page)).toBeEnabled();
  await expect(depositButton(page)).toHaveCount(0);
  expect(state.walletRequests).toHaveLength(2);
  state.chain.state.outcomes.approve = "success";
  await approveButton(page).click();
  await expect(depositButton(page)).toBeEnabled();
  expect(state.walletRequests).toHaveLength(3);
});

for (const field of [
  "factoryAddress",
  "vaultName",
  "adminAddress",
  "pauserAddress",
  "fractionalizerAddress",
] as const) {
  test(`vault refuses mismatched returned ${field} before requesting the wallet`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.vaultOverrides[field] =
      field === "vaultName"
        ? "TEST_ONLY unreviewed name"
        : addresses.otherWallet;
    await openVault(page);
    await vaultButton(page).click();
    await expect(page.locator(".dao-create").getByRole("alert")).toContainText(
      "does not match every reviewed",
    );
    expect(state.walletRequests).toHaveLength(0);
  });
}

test("owned NFT selection uses current ownership rather than historical mint recipient", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.chain.state.owner = addresses.otherWallet;
  await openVault(page, true);
  await expect(
    page.getByLabel("ERC-721 collection", { exact: true }),
  ).toHaveValue(addresses.collection);
  await expect(page.getByLabel("Token ID", { exact: true })).toHaveValue("1");
  await page
    .getByRole("button", { name: "Find my owned NFTs", exact: true })
    .click();
  await expect(
    page.getByText(
      "0 currently owned NFT(s) found in the latest 100 indexed mints. Manual entry remains available.",
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Currently owned NFT", { exact: true }),
  ).toHaveCount(0);
  await vaultButton(page).click();
  await expect(page.locator(".dao-create").getByRole("alert")).toContainText(
    "must own this NFT",
  );
  expect(state.walletRequests).toHaveLength(0);
});

for (const authorized of [true, false]) {
  test(`confirmed Vault handoff ${authorized ? "lets B issue without registrar" : "rejects unauthorized C"}`, async ({
    page,
  }) => {
    const state = await setupFixture(page);
    state.vaultOverrides.fractionalizerAddress = addresses.otherWallet;
    await openVault(page);
    await page
      .locator('input[name="fractionalizerAddress"]')
      .fill(addresses.otherWallet);
    await vaultButton(page).click();
    await approveButton(page).click();
    await depositButton(page).click();
    await expect(issueButton(page)).toBeEnabled();
    state.operatorAuthenticated = false;
    state.operatorSessionStatus = 401;
    const wallet = authorized
      ? addresses.otherWallet
      : ("0x1000000000000000000000000000000000000040" as Address);
    await switchWallet(page, state, wallet);
    await expect(
      page.getByRole("button", { name: "Verify operator wallet", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Review and continue Vault", exact: true })
      .click();
    if (!authorized) {
      await expect(
        page.locator(".dao-create").getByRole("alert"),
      ).toContainText("FRACTIONALIZER_ROLE");
      await expect(issueButton(page)).toHaveCount(0);
      expect(state.walletRequests).toHaveLength(3);
      return;
    }
    await expect(issueButton(page)).toBeEnabled();
    await issueButton(page).click();
    await expect(
      page.getByRole("heading", {
        name: "DAO asset setup confirmed",
        exact: true,
      }),
    ).toBeVisible();
    expect(state.walletRequests).toHaveLength(4);
    expect(state.walletRequests[3].from.toLowerCase()).toBe(
      addresses.otherWallet.toLowerCase(),
    );
    const original = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)!),
      `artfi:setup:vault:560048:${addresses.wallet}`,
    );
    expect(original.data.stage).toBe("deposited");
    expect(original.pending).toBeUndefined();
    const issuer = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)!),
      `artfi:setup:vault:560048:${addresses.otherWallet}`,
    );
    expect(issuer.data.depositorAddress.toLowerCase()).toBe(
      addresses.wallet.toLowerCase(),
    );
    expect(issuer.data.stage).toBe("complete");
  });
}

test("completed wallet can explicitly prepare another NFT while old chain identity and log recovery remain available", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.submissionStatus = 503;
  await openVault(page);
  await vaultButton(page).click();
  await approveButton(page).click();
  await depositButton(page).click();
  await issueButton(page).click();
  await expect(
    page.getByRole("button", { name: "Prepare another Vault", exact: true }),
  ).toBeEnabled();
  await page.goto(
    `/dao?chainId=560048&collectionAddress=${addresses.collection}&tokenId=2`,
  );
  await page
    .getByRole("button", { name: "Prepare another Vault", exact: true })
    .click();
  await expect(page.getByLabel("Token ID", { exact: true })).toHaveValue("2");
  await expect(vaultButton(page)).toBeEnabled();
  await page.getByLabel("Vault / DAO name").fill("TEST_ONLY Second Vault");
  await page
    .getByLabel("Fraction token name")
    .fill("TEST_ONLY Second Fractions");
  await page.getByLabel("Symbol", { exact: true }).fill("NEXT");
  await page.getByLabel("Whole-token supply").fill("200");
  state.vaultOverrides.tokenId = "2";
  state.vaultOverrides.vaultName = "TEST_ONLY Second Vault";
  state.vaultOverrides.requestId = `0x${"91".repeat(32)}`;
  state.walletResults = ["reject"];
  await vaultButton(page).click();
  await expect.poll(() => state.walletRequests.length).toBe(5);
  const second = decodeFunctionData({
    abi: vaultFactoryAbi,
    data: state.walletRequests[4].data,
  });
  expect(second.functionName).toBe("createVault");
  expect(second.args?.[3]).toBe(2n);
  expect(state.vaultIntents).toHaveLength(2);
  expect(state.vaultIntents[0].key).not.toBe(state.vaultIntents[1].key);
  const savedVaults = page.getByRole("region", {
    name: "Saved confirmed Vaults",
  });
  await expect(savedVaults).toContainText("TEST_ONLY Recovery DAO");
  await expect(savedVaults).toContainText("#1");
  const savedToken = savedVaults.getByRole("link", {
    name: "View saved issued token ↗",
    exact: true,
  });
  await expect(savedToken).toBeVisible();
  await expect(savedToken).toHaveAttribute(
    "href",
    `https://hoodi.etherscan.io/token/${addresses.fraction}?a=${addresses.wallet}`,
  );
  await expect(
    page.getByRole("button", {
      name: "Retry saved Vault submission",
      exact: true,
    }),
  ).toBeVisible();
});

test("first operator session 401 keeps public config and verification unlocks creation without reload", async ({
  page,
}) => {
  const state = await setupFixture(page);
  state.operatorAuthenticated = false;
  state.operatorSessionStatus = 401;
  await page.goto("/dao");
  await connect(page);
  await expect(
    page.getByText(`Reviewed Hoodi VaultFactory: ${addresses.factory}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(vaultButton(page)).toBeDisabled();
  await page
    .getByRole("button", { name: "Verify operator wallet", exact: true })
    .click();
  await expect(vaultButton(page)).toBeEnabled();
  await page
    .getByLabel("ERC-721 collection", { exact: true })
    .fill(addresses.collection);
  await page.getByLabel("Token ID", { exact: true }).fill("1");
  await page.getByLabel("Vault / DAO name").fill("TEST_ONLY Recovery DAO");
  await page.getByLabel("Fraction token name").fill("TEST_ONLY Fractions");
  await page.getByLabel("Symbol", { exact: true }).fill("TEST");
  await page.getByLabel("Whole-token supply").fill("100");
  await vaultButton(page).click();
  await expect(approveButton(page)).toBeEnabled();
  expect(state.walletRequests).toHaveLength(1);
});
