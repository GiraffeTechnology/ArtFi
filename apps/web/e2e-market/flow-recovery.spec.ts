import { expect, test, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  zeroHash,
  toFunctionSelector,
  type Hex,
} from "viem";
import { charityEditionsAbi } from "../src/lib/contracts";

// Contract read fixtures make the real edition surface reachable. They are not
// live collection observations and do not bypass the component's configured reads.
function editionCall(data: Hex): Hex {
  // RainbowKit reads the connected account's native balance through Multicall3.
  if (data.startsWith(toFunctionSelector("getEthBalance(address)")))
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "getEthBalance",
      result: 0n,
    });
  if (data.startsWith("0x82ad56cb")) {
    const call = decodeFunctionData({ abi: multicall3Abi, data });
    if (call.functionName !== "aggregate3")
      throw new Error("Unexpected multicall fixture method");
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: call.args[0].map((call) => ({
        success: true,
        returnData: editionCall(call.callData),
      })),
    });
  }
  const { functionName } = decodeFunctionData({
    abi: charityEditionsAbi,
    data,
  });
  switch (functionName) {
    case "series":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: {
          artworkId: zeroHash,
          masterArtworkHash: zeroHash,
          metadataHash: zeroHash,
          distributionWallet: "0x1000000000000000000000000000000000000030",
          createdAt: 1760000000n,
          soldOutAt: 0n,
          physicalDonationRecordedAt: 0n,
          selloutEvidenceHash: zeroHash,
          physicalDonationEvidenceHash: zeroHash,
          metadataURI: "ipfs://TEST_ONLY-edition-1",
        },
      });
    case "totalSupply":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 100n,
      });
    case "balanceOf":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 63n,
      });
    case "PRIMARY_PRICE_WEI":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 10000000000000000n,
      });
    default:
      throw new Error(`Unexpected charity fixture read: ${functionName}`);
  }
}

const walletA = "0x1000000000000000000000000000000000000010";
const walletB = "0x1000000000000000000000000000000000000020";

/** Isolated injected fixture: no origin permission until an explicit Connect click. */
async function walletFixture(page: Page) {
  await page.addInitScript(
    ({ walletA }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      let account = walletA;
      let authorized =
        sessionStorage.getItem("artfi-flow-wallet-authorized") === "true";
      const permit = () => {
        authorized = true;
        sessionStorage.setItem("artfi-flow-wallet-authorized", "true");
        return [
          {
            parentCapability: "eth_accounts",
            caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
          },
        ];
      };
      const change = (next?: string) => {
        if (next) account = next;
        authorized = Boolean(next);
        listeners.accountsChanged?.forEach((listener) =>
          listener(next ? [next] : []),
        );
      };
      Object.defineProperty(window, "artfiFlowFixture", { value: { change } });
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
              listeners[event]?.filter((entry) => entry !== listener) ?? [];
          },
          async request({ method }: { method: string }) {
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
              sessionStorage.removeItem("artfi-flow-wallet-authorized");
              return null;
            }
            if (method === "eth_chainId") return "0x88bb0";
            if (method === "wallet_getCapabilities") return {};
            if (method === "personal_sign") {
              await fetch("/test-flow-sign", { method: "POST" });
              return `0x${"11".repeat(65)}`;
            }
            throw new Error(`Unsupported fixture method: ${method}`);
          },
        },
      });
    },
    { walletA },
  );
  await page.route("**/test-hoodi-rpc", async (route) => {
    const answer = (request: {
      id: number;
      method: string;
      params?: unknown[];
    }) => ({
      id: request.id,
      jsonrpc: "2.0",
      result:
        request.method === "eth_chainId"
          ? "0x88bb0"
          : request.method === "eth_blockNumber"
            ? "0x64"
            : request.method === "eth_call"
              ? editionCall((request.params?.[0] as { data: Hex }).data)
              : "0x0",
    });
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: Array.isArray(body) ? body.map(answer) : answer(body),
    });
  });
}

async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .first()
    .click();
  await expect(page.locator(".wallet-button--connected").first()).toBeVisible();
}

async function switchWallet(page: Page, address?: string) {
  await page.evaluate((next) => {
    (
      window as unknown as {
        artfiFlowFixture: { change: (address?: string) => void };
      }
    ).artfiFlowFixture.change(next);
  }, address);
}

async function holderFixture(page: Page, expiresIn = 600_000) {
  let verifyRequests = 0;
  await page.route("**/api/charity/holder/challenge", (route) =>
    route.fulfill({
      json: { message: "Test-only edition 1 ownership challenge" },
    }),
  );
  await page.route("**/api/charity/holder/verify", (route) => {
    verifyRequests++;
    return route.fulfill({
      json: {
        address: walletA,
        tokenId: "1",
        expiresAt: new Date(Date.now() + expiresIn).toISOString(),
      },
    });
  });
  await page.route("**/api/charity/editions/1/holder-asset", (route) =>
    route.fulfill({
      json: {
        contentType: "image/png",
        byteLength: 20,
        sha256: "a".repeat(64),
      },
    }),
  );
  return () => verifyRequests;
}

test("holder access resets on wallet changes and ignores a departed signature", async ({
  page,
}) => {
  await walletFixture(page);
  const verifyCount = await holderFixture(page);
  let holdSignature = false;
  let releaseSignature: (() => void) | undefined;
  await page.route("**/test-flow-sign", async (route) => {
    if (holdSignature)
      await new Promise<void>((resolve) => {
        releaseSignature = resolve;
      });
    await route.fulfill({ json: {} });
  });
  await page.goto("/charity/1");
  await connect(page);
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Download the watermarked copy" }),
  ).toBeVisible();
  await switchWallet(page, walletB);
  await expect(
    page.getByText("Ownership not yet verified", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download the watermarked copy" }),
  ).toHaveCount(0);
  await switchWallet(page, walletA);
  holdSignature = true;
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .click();
  await expect.poll(() => Boolean(releaseSignature)).toBe(true);
  const before = verifyCount();
  await switchWallet(page, walletB);
  releaseSignature!();
  await expect(
    page.getByText("Ownership not yet verified", { exact: true }),
  ).toBeVisible();
  expect(verifyCount()).toBe(before);
  await expect(
    page.getByRole("link", { name: "Download the watermarked copy" }),
  ).toHaveCount(0);
});

test("expired holder access removes the download and exposes verification retry", async ({
  page,
}) => {
  await walletFixture(page);
  await page.clock.install({ time: new Date() });
  await holderFixture(page);
  await page.route("**/test-flow-sign", (route) => route.fulfill({ json: {} }));
  await page.goto("/charity/1");
  await connect(page);
  await page
    .getByRole("button", { name: "Verify ownership", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Download the watermarked copy" }),
  ).toBeVisible();
  await page.clock.fastForward(660_000);
  await expect(
    page.getByText("Holder access expired. Verify ownership again."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download the watermarked copy" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Verify ownership", exact: true }),
  ).toBeEnabled();
});

test("portfolio retry and wallet switch never display another wallet's holdings", async ({
  page,
}) => {
  await walletFixture(page);
  let phase: "failed" | "ready" | "hold-wallet-b" = "failed";
  const heldWalletB: Array<() => void> = [];
  await page.route("**/v1/portfolio/**", async (route) => {
    if (phase === "failed")
      return route.fulfill({
        status: 503,
        json: { detail: "Fixture index unavailable" },
      });
    const address = route.request().url().split("/").at(-1)!;
    if (
      phase === "hold-wallet-b" &&
      address.toLowerCase() === walletB.toLowerCase()
    )
      await new Promise<void>((resolve) => {
        heldWalletB.push(resolve);
      });
    await route.fulfill({
      json: {
        address,
        chainId: 560048,
        network: "hoodi",
        positions: [
          {
            assetToken: address,
            symbol:
              address.toLowerCase() === walletA.toLowerCase()
                ? "WALLET_A_ONLY"
                : "WALLET_B_ONLY",
            balance: "2",
            updatedAt: "2026-10-02",
          },
        ],
        transactions: [],
        offers: [],
        notifications: [],
      },
    });
  });
  // Use the same explicit permission flow as the holder tests, then navigate with that wallet.
  await page.goto("/charity/1");
  await connect(page);
  await page.goto("/portfolio");
  await expect(
    page.getByRole("button", { name: "Retry indexed records" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No indexed token position is associated with this address.",
    ),
  ).toHaveCount(0);
  phase = "ready";
  await page.getByRole("button", { name: "Retry indexed records" }).click();
  await expect(page.getByText("WALLET_A_ONLY", { exact: true })).toBeVisible();
  phase = "hold-wallet-b";
  await switchWallet(page, walletB);
  await expect.poll(() => heldWalletB.length).toBeGreaterThan(0);
  await expect(
    page.getByText("Loading indexed records…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("WALLET_A_ONLY", { exact: true })).toHaveCount(0);
  phase = "ready";
  heldWalletB.forEach((release) => release());
  await expect(page.getByText("WALLET_B_ONLY", { exact: true })).toBeVisible();
  await switchWallet(page);
  await expect(
    page.getByText(
      "Connect a wallet to query the indexed public records for its address.",
    ),
  ).toBeVisible();
  await expect(page.getByText("WALLET_B_ONLY", { exact: true })).toHaveCount(0);
});
