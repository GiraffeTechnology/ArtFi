import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  artFiAdminSafeAbi,
  charityEditionsAbi,
  rwaRegistryAbi,
} from "../src/lib/contracts";
import {
  createAdminSafeChainFixture,
  safeTestAddresses as a,
} from "../src/test/admin-safe-chain-fixture";
import { sourceMintFixture } from "../src/test/rwa-source-fixture";
import {
  setupMetadataHash,
  setupMetadataUri,
  setupRequestIds,
} from "../src/test/setup-chain-fixture";

async function fixture(page: Page) {
  const chain = createAdminSafeChainFixture();
  const mintContext = {
    requestId: setupRequestIds.mint,
    recipient: a.wallet,
    registryAddress: a.registry,
    chainId: 560048,
    metadataUri: setupMetadataUri,
    metadataSha256: setupMetadataHash,
  };
  const source = sourceMintFixture(mintContext);
  const renewedSource = sourceMintFixture(mintContext, {
    validUntil: Math.floor(Date.now() / 1000) + 7200,
  });
  const state = {
    account: a.wallet as Address,
    walletRequests: [] as { from: Address; to: Address; data: Hex }[],
    outcome: "accept" as "accept" | "reject" | "lost",
    submissions: [] as { kind: string; hash: string }[],
    chain,
    source,
    renewedSource,
  };
  await page.route("**/*", (route) =>
    ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  await page.addInitScript(
    ({ wallet }) => {
      let account = sessionStorage.getItem("TEST_ONLY-safe-account") || wallet;
      let authorized =
        sessionStorage.getItem("TEST_ONLY-safe-connected") === "yes";
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const permit = () => {
        authorized = true;
        sessionStorage.setItem("TEST_ONLY-safe-connected", "yes");
        return [
          {
            parentCapability: "eth_accounts",
            caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
          },
        ];
      };
      Object.defineProperty(window, "safeTestWallet", {
        value: {
          change(next: string) {
            account = next;
            sessionStorage.setItem("TEST_ONLY-safe-account", next);
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
              return null;
            }
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "eth_sendTransaction") {
              const response = await fetch("/test-safe-wallet", {
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
            throw new Error(`Unexpected TEST_ONLY wallet call ${method}`);
          },
        },
      });
    },
    { wallet: a.wallet },
  );
  await page.route("**/test-safe-wallet", async (route) => {
    const input = route.request().postDataJSON();
    state.walletRequests.push(input);
    if (state.outcome === "reject") {
      state.outcome = "accept";
      return route.fulfill({
        json: {
          error: { code: 4001, message: "TEST_ONLY user rejected the request" },
        },
      });
    }
    const hash = chain.submit(input);
    if (state.outcome === "lost") {
      state.outcome = "accept";
      return route.fulfill({
        json: {
          error: { code: -32000, message: "TEST_ONLY wallet response lost" },
        },
      });
    }
    return route.fulfill({ json: { hash } });
  });
  await page.route("**/test-hoodi-rpc", (route) => {
    const input = route.request().postDataJSON();
    return route.fulfill({
      json: Array.isArray(input) ? input.map(chain.rpc) : chain.rpc(input),
    });
  });
  await page.route("**/api/user/auth/*", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "TEST_ONLY-safe-session",
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
      json: {
        authenticated: true,
        address: state.account,
        chainId: 560048,
        safeAddress: a.safe,
      },
    }),
  );
  await page.route("**/v1/config", (route) =>
    route.fulfill({
      json: {
        chainId: 560048,
        network: "hoodi",
        registryAddress: a.registry,
        vaultFactoryAddress: a.factory,
      },
    }),
  );
  await page.route("**/v1/nfts?**", (route) =>
    route.fulfill({
      json: {
        data: [],
        chainId: 560048,
        runtime: true,
        total: 0,
        page: 1,
        pageSize: 100,
      },
    }),
  );
  await page.route("**/api/operator/v1/uploads/intents", (route) =>
    route.fulfill({
      json: {
        uploadId: "TEST-ONLY-safe-upload",
        uploadUrl: "/v1/uploads/TEST-ONLY-safe-upload",
      },
    }),
  );
  await page.route(
    "**/api/operator/v1/uploads/TEST-ONLY-safe-upload",
    (route) => route.fulfill({ json: { completed: true } }),
  );
  const mintIntent = {
    intentId: "TEST-ONLY-safe-mint",
    requestId: setupRequestIds.mint,
    recipient: a.wallet,
    registryAddress: a.registry,
    chainId: 560048,
    metadataUri: setupMetadataUri,
    metadataSha256: setupMetadataHash,
    status: "prepared",
    ...source,
  };
  const vaultIntent = {
    intentId: "TEST-ONLY-safe-vault",
    requestId: setupRequestIds.vault,
    factoryAddress: a.factory,
    collectionAddress: a.collection,
    tokenId: "1",
    vaultName: "TEST_ONLY Recovery DAO",
    adminAddress: a.wallet,
    pauserAddress: a.wallet,
    fractionalizerAddress: a.wallet,
    chainId: 560048,
    status: "prepared",
  };
  for (const kind of ["rwa", "vault"]) {
    const intent = kind === "rwa" ? mintIntent : vaultIntent;
    await page.route(`**/api/operator/v1/${kind}/intents`, (route) => {
      if (kind === "vault")
        Object.assign(vaultIntent, route.request().postDataJSON());
      return route.fulfill({ json: intent });
    });
    await page.route(
      `**/api/operator/v1/${kind}/intents/TEST-ONLY-safe-*`,
      (route) => route.fulfill({ json: intent }),
    );
    await page.route(
      `**/api/operator/v1/${kind}/intents/TEST-ONLY-safe-*/submission`,
      (route) => {
        state.submissions.push({
          kind,
          hash: route.request().postDataJSON().transactionHash,
        });
        return route.fulfill({ json: { status: "submitted" } });
      },
    );
  }
  await page.route(
    "**/api/operator/v1/rwa/intents/TEST-ONLY-safe-mint/evidence",
    (route) => {
      expect(route.request().postDataJSON().evidence).toEqual(
        renewedSource.sourceEvidence,
      );
      Object.assign(mintIntent, renewedSource);
      return route.fulfill({ json: mintIntent });
    },
  );
  return state;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const panel = (page: Page) => page.locator(".admin-safe-console");
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
async function switchOwner(page: Page, state: Fixture, address: Address) {
  state.account = address;
  await page.evaluate(
    (next) =>
      (
        window as unknown as {
          safeTestWallet: { change: (value: string) => void };
        }
      ).safeTestWallet.change(next),
    address,
  );
  await expect(panel(page).getByText(/Threshold: 2 of 2/)).toBeVisible();
}
async function openCharity(page: Page) {
  await page.goto("/create/rwa?standard=erc1155");
  await connect(page);
  await page
    .getByLabel("Artwork ID commitment (bytes32)", { exact: true })
    .fill(`0x${"81".repeat(32)}`);
  await page
    .getByLabel("Private master SHA-256 commitment (bytes32)")
    .fill(`0x${"82".repeat(32)}`);
  await page
    .getByLabel("Public metadata SHA-256 commitment (bytes32)")
    .fill(`0x${"83".repeat(32)}`);
  await page.getByLabel("Distribution wallet", { exact: true }).fill(a.wallet);
  await page
    .getByLabel("No-preview metadata URI")
    .fill("ipfs://TEST_ONLY-safe-edition");
  await page
    .getByRole("checkbox", { name: /I verified the off-repository/ })
    .check();
  await page
    .getByRole("button", { name: "Review and mint ERC-1155 on Hoodi" })
    .click();
  await expect(
    panel(page).getByText("Unsigned exact call review"),
  ).toBeVisible();
}
async function openRwa(page: Page, state: Fixture) {
  await page.goto("/create/rwa");
  await connect(page);
  await page
    .getByLabel("Work title", { exact: true })
    .fill("TEST_ONLY Safe Artwork");
  await page.getByLabel("Artist or maker").fill("TEST_ONLY Maker");
  await page.getByLabel("Year", { exact: true }).fill("2026");
  await page.getByLabel("Medium", { exact: true }).fill("TEST_ONLY fixture");
  await page.getByLabel("Location", { exact: true }).fill("TEST_ONLY isolated");
  await page
    .getByLabel("Description", { exact: true })
    .fill("TEST_ONLY bounded multisignature creation fixture.");
  await page.getByLabel("Rights-cleared image").setInputFiles({
    name: "TEST_ONLY-safe.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page
    .getByRole("textbox", {
      name: "Signed source evidence (JSON)",
      exact: true,
    })
    .fill(JSON.stringify(state.source.sourceEvidence));
  await page
    .getByRole("button", { name: "Review and mint on Hoodi", exact: true })
    .click();
  await expect(
    panel(page).getByText("Unsigned exact call review"),
  ).toBeVisible();
}
async function review(page: Page) {
  await panel(page)
    .getByRole("checkbox", { name: /I independently reviewed/ })
    .check();
}
async function submitProposal(page: Page) {
  await review(page);
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
}
async function loadProposal(page: Page) {
  await panel(page).getByLabel("Proposal ID from another owner").fill("1");
  await panel(page).getByRole("button", { name: "Load safe proposal" }).click();
  await review(page);
}
async function confirmAndExecute(page: Page, state: Fixture) {
  await switchOwner(page, state, a.otherWallet);
  await loadProposal(page);
  await panel(page)
    .getByRole("button", { name: "Confirm as this owner" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting timelock/),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("button", { name: "Execute confirmed proposal" }),
  ).toBeDisabled();
  state.chain.state.now += 60n;
  await panel(page)
    .getByRole("button", { name: "Refresh safe status" })
    .click();
  await expect(
    panel(page).getByRole("button", { name: "Execute confirmed proposal" }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "Execute confirmed proposal" })
    .click();
  await expect(panel(page).getByText(/Proposal 1: executed/)).toBeVisible();
}

test("charity safe submission, independent confirmation, revocation, timelock and execution survive reload", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await openCharity(page);
  expect(state.walletRequests).toHaveLength(0);
  await expect(panel(page)).toHaveAttribute("data-no-translate", "true");
  await submitProposal(page);
  expect(
    decodeFunctionData({
      abi: artFiAdminSafeAbi,
      data: state.walletRequests[0].data,
    }).functionName,
  ).toBe("submit");
  await page.reload();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
  await switchOwner(page, state, a.otherWallet);
  await loadProposal(page);
  await panel(page)
    .getByRole("button", { name: "Confirm as this owner" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting timelock/),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Revoke my confirmation" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
  expect(state.chain.state.proposals[0].readyAt).toBe(0n);
  await panel(page)
    .getByRole("button", { name: "Confirm as this owner" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting timelock/),
  ).toBeVisible();
  state.chain.state.now += 60n;
  await panel(page)
    .getByRole("button", { name: "Refresh safe status" })
    .click();
  await panel(page)
    .getByRole("button", { name: "Execute confirmed proposal" })
    .click();
  await expect(panel(page).getByText(/Proposal 1: executed/)).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Recover creation result" })
    .click();
  await expect(
    page.getByRole("heading", { name: "ERC-1155 series confirmed" }),
  ).toBeVisible();
  expect(state.chain.state.proposals[0].target.toLowerCase()).toBe(a.charity);
  const call = decodeFunctionData({
    abi: charityEditionsAbi,
    data: state.chain.state.proposals[0].data,
  });
  expect(call.functionName).toBe("createSeries");
  expect(call.args?.[3]).toBe(a.wallet);
  expect(state.chain.state.unknownCalls).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("TEST_ONLY-safe-charity-complete.png"),
    fullPage: true,
  });
  await panel(page).screenshot({
    path: testInfo.outputPath("TEST_ONLY-safe-console.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a lost wallet response remains blocked across reload and recovers from the exact original hash", async ({
  page,
}) => {
  const state = await fixture(page);
  await openCharity(page);
  await review(page);
  state.outcome = "lost";
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(
    panel(page).getByText(/wallet request is unresolved/),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(1);
  await page.reload();
  await expect(
    panel(page).getByText(/wallet request is unresolved/),
  ).toBeVisible();
  await panel(page)
    .getByLabel("Original wallet transaction hash")
    .fill(state.chain.state.transactions[0].hash);
  await panel(page)
    .getByRole("button", { name: "Refresh safe status" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(1);
  expect(state.chain.state.proposals).toHaveLength(1);
});

test("wallet rejection leaves the same reviewed call available for a deliberate retry", async ({
  page,
}) => {
  const state = await fixture(page);
  await openCharity(page);
  await review(page);
  state.outcome = "reject";
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(panel(page).getByRole("alert")).toContainText(/rejected/i);
  await expect(
    panel(page).getByRole("button", { name: "Submit safe proposal" }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(2);
  expect(state.walletRequests[0].data).toBe(state.walletRequests[1].data);
});

test("source-bound RWA creation executes through the safe and recovers the original recipient", async ({
  page,
}) => {
  const state = await fixture(page);
  await openRwa(page, state);
  expect(state.walletRequests).toHaveLength(0);
  await submitProposal(page);
  await confirmAndExecute(page, state);
  const executionHash = state.chain.state.transactions.at(-1)!.hash;
  await switchOwner(page, state, a.wallet);
  await panel(page)
    .getByRole("button", { name: "Refresh safe status" })
    .click();
  await panel(page)
    .getByLabel("Execution transaction hash (any owner)")
    .fill(executionHash);
  await panel(page)
    .getByRole("button", { name: "Check execution receipt" })
    .click();
  await panel(page)
    .getByRole("button", { name: "Recover creation result" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Mint confirmed on Hoodi" }),
  ).toBeVisible();
  expect(state.submissions).toContainEqual({
    kind: "rwa",
    hash: executionHash,
  });
  expect(
    state.chain.base.state.transactions.filter(
      (transaction) => transaction.action === "mint",
    ),
  ).toHaveLength(1);
  expect(
    state.chain.base.state.transactions.find(
      (transaction) => transaction.action === "mint",
    )?.from,
  ).toBe(a.safe);
});

test("Vault creation uses a proposal and preserves the separate exact-token custody steps", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(
    `/dao?chainId=560048&collectionAddress=${a.collection}&tokenId=1`,
  );
  await connect(page);
  await page.getByLabel("Vault / DAO name").fill("TEST_ONLY Recovery DAO");
  await page.getByLabel("Fraction token name").fill("TEST_ONLY Fractions");
  await page.getByLabel("Symbol", { exact: true }).fill("TEST");
  await page.getByLabel("Whole-token supply").fill("100");
  await page.getByRole("button", { name: "Step 1 · Create Vault" }).click();
  await expect(
    panel(page).getByText("Unsigned exact call review"),
  ).toBeVisible();
  const reviewedRoles = JSON.parse(
    await panel(page).getByLabel("Decoded arguments").inputValue(),
  );
  expect(reviewedRoles.admin.toLowerCase()).toBe(a.safe);
  expect(reviewedRoles.pauser.toLowerCase()).toBe(a.safe);
  expect(reviewedRoles.fractionalizer.toLowerCase()).toBe(a.wallet);
  await submitProposal(page);
  await confirmAndExecute(page, state);
  const executionHash = state.chain.state.transactions.at(-1)!.hash;
  await switchOwner(page, state, a.wallet);
  await panel(page)
    .getByRole("button", { name: "Refresh safe status" })
    .click();
  await panel(page)
    .getByLabel("Execution transaction hash (any owner)")
    .fill(executionHash);
  await panel(page)
    .getByRole("button", { name: "Check execution receipt" })
    .click();
  await panel(page)
    .getByRole("button", { name: "Recover creation result" })
    .click();
  await expect(
    page.getByRole("button", { name: "Step 2 · Approve this token only" }),
  ).toBeEnabled();
  expect(state.submissions).toContainEqual({
    kind: "vault",
    hash: executionHash,
  });
  expect(state.chain.base.state.deposited).toBe(false);
});

test("renewed RWA call bytes get a separate safe proposal while the original mint identity stays unchanged", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await openRwa(page, state);
  await submitProposal(page);
  const first = state.chain.state.proposals[0];
  await page
    .getByRole("textbox", {
      name: "Signed source evidence (JSON)",
      exact: true,
    })
    .fill(JSON.stringify(state.renewedSource.sourceEvidence));
  await page
    .getByRole("button", { name: "Retry prepared mint", exact: true })
    .click();
  await expect(
    panel(page).getByText(/Proposal 1 remains on chain/),
  ).toBeVisible();
  await review(page);
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(
    panel(page).getByText(/Proposal 2: awaiting confirmations/),
  ).toBeVisible();
  const renewed = state.chain.state.proposals[1];
  expect(renewed.requestId).not.toBe(first.requestId);
  expect(renewed.data).not.toBe(first.data);
  expect(
    decodeFunctionData({ abi: rwaRegistryAbi, data: first.data }).args?.[0],
  ).toBe(setupRequestIds.mint);
  expect(
    decodeFunctionData({ abi: rwaRegistryAbi, data: renewed.data }).args?.[0],
  ).toBe(setupRequestIds.mint);
  await panel(page).getByLabel("Proposal ID from another owner").fill("1");
  await panel(page).getByRole("button", { name: "Load safe proposal" }).click();
  await expect(
    panel(page).getByText(/Proposal 1: awaiting confirmations/),
  ).toBeVisible();
  await expect(panel(page).getByLabel("Exact calldata")).toHaveValue(
    first.data,
  );
  await panel(page).screenshot({
    path: testInfo.outputPath("TEST_ONLY-safe-old-proposal-review.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await panel(page)
    .getByRole("button", { name: "Review newly prepared call" })
    .click();
  await review(page);
  await panel(page)
    .getByRole("button", { name: "Submit safe proposal" })
    .click();
  await expect(panel(page).getByText(/already exists/)).toBeVisible();
  await expect(
    panel(page).getByText(/Proposal 2: awaiting confirmations/),
  ).toBeVisible();
  expect(state.walletRequests).toHaveLength(2);
  expect(state.chain.state.proposals).toHaveLength(2);
  expect(state.chain.base.state.minted).toBe(false);
});

test("explicit Vault role addresses are preserved in a safe deployment", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(
    `/dao?chainId=560048&collectionAddress=${a.collection}&tokenId=1`,
  );
  await connect(page);
  await page.getByLabel("Vault / DAO name").fill("TEST_ONLY Recovery DAO");
  await page.getByLabel("Fraction token name").fill("TEST_ONLY Fractions");
  await page.getByLabel("Symbol", { exact: true }).fill("TEST");
  await page.getByLabel("Whole-token supply").fill("100");
  await page.getByLabel(/^admin role/).fill(a.otherWallet);
  await page.getByLabel(/^pauser role/).fill(a.otherWallet);
  await page.getByRole("button", { name: "Step 1 · Create Vault" }).click();
  await expect(
    panel(page).getByText("Unsigned exact call review"),
  ).toBeVisible();
  const reviewed = JSON.parse(
    await panel(page).getByLabel("Decoded arguments").inputValue(),
  );
  expect(reviewed.admin.toLowerCase()).toBe(a.otherWallet);
  expect(reviewed.pauser.toLowerCase()).toBe(a.otherWallet);
  expect(reviewed.fractionalizer.toLowerCase()).toBe(a.wallet);
  expect(state.walletRequests).toHaveLength(0);
});
