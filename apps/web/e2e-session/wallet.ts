import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  hexToString,
  zeroAddress,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  fractionIntentTypedData,
  fractionIntentTypes,
} from "../src/lib/fraction-intent";
import {
  nativeOrderFromAuthorization,
  type NativeOrderKind,
} from "../src/lib/native-order";
import {
  saleIntentTypedData,
  saleIntentTypes,
} from "../src/lib/whole-artwork-intent";
import {
  sessionRPCResult,
  type SessionRPCRequest,
} from "../src/test/session-chain-fixture";
import {
  sessionEnvironment as fixture,
  sessionSourceFixture,
} from "./environment";

/** Key material stays in this Node closure and is never serialized to the browser or disk. */
export function ephemeralSigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase() as Address;
  return {
    address,
    async signMessage(raw: Hex) {
      return account.signMessage({ message: { raw } });
    },
    async signTypedData(payload: TypedDataDefinition) {
      return account.signTypedData(payload);
    },
    async signedOrder(kind: NativeOrderKind) {
      const now = Math.floor(Date.now() / 1000);
      const common = {
        seller: address,
        paymentToken: fixture.paymentToken,
        buyer: zeroAddress,
        salt: BigInt(`0x${randomBytes(16).toString("hex")}`),
        startsAt: now - 1,
        endsAt: now + 3600,
        epoch: 0n,
      };
      const market =
        kind === "whole" ? fixture.wholeMarket : fixture.fractionMarket;
      const domain = { chainId: fixture.chainId, verifyingContract: market };
      let intent;
      let signature;
      if (kind === "whole") {
        const typed = saleIntentTypedData(
          {
            ...common,
            collection: fixture.collection,
            tokenId: 1n,
            price: 123n,
          },
          domain,
        );
        intent = typed.message;
        signature = await account.signTypedData(typed);
      } else {
        const typed = fractionIntentTypedData(
          {
            ...common,
            assetToken: fixture.fractionToken,
            maxAmount: 10n,
            unitPrice: 41n,
          },
          domain,
        );
        intent = typed.message;
        signature = await account.signTypedData(typed);
      }
      return nativeOrderFromAuthorization(
        kind,
        JSON.stringify(
          {
            intent,
            signature,
          },
          (_, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
        market,
      );
    },
  };
}

type WalletRequest = { method: string; params?: unknown[] };

export async function installSessionWallet(page: Page) {
  const signer = ephemeralSigner();
  const state = {
    personalSigns: 0,
    saleSigns: 0,
    transactionAttempts: 0,
    publicationPosts: 0,
    unexpectedWalletMethods: 0,
    unsupportedRPC: 0,
    unsupportedRPCIdentifiers: new Set<string>(),
    blockedExternalRequests: 0,
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === fixture.webURL &&
      url.pathname === "/api/orders" &&
      request.method() === "POST"
    )
      state.publicationPosts++;
  });

  await page.exposeFunction(
    "TEST_ONLY_artfiWalletRequest",
    async ({ method, params }: WalletRequest) => {
      if (
        method === "eth_sendTransaction" ||
        method === "eth_sendRawTransaction" ||
        method === "eth_signTransaction" ||
        method === "wallet_sendCalls"
      ) {
        state.transactionAttempts++;
        throw new Error(
          "TEST_ONLY signing suite refuses every blockchain write.",
        );
      }
      if (method === "personal_sign") {
        state.personalSigns++;
        const raw = params?.[0];
        if (
          typeof raw !== "string" ||
          !/^0x(?:[0-9a-f]{2})+$/i.test(raw) ||
          String(params?.[1]).toLowerCase() !== signer.address
        )
          throw new Error("Unexpected TEST_ONLY sign-in request.");
        const message = hexToString(raw as Hex);
        if (
          !message.startsWith(
            "127.0.0.1:3003 wants you to sign in with your Ethereum account:",
          ) ||
          !message.includes(signer.address) ||
          !message.includes(`URI: ${fixture.webURL}`) ||
          !message.includes(`Chain ID: ${fixture.chainId}`)
        )
          throw new Error("Unexpected TEST_ONLY sign-in domain.");
        return signer.signMessage(raw as Hex);
      }
      if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
        state.saleSigns++;
        const payload =
          typeof params?.[1] === "string" ? JSON.parse(params[1]) : params?.[1];
        const market = payload?.domain?.verifyingContract?.toLowerCase();
        const whole = market === fixture.wholeMarket;
        const expectedTypes = whole
          ? saleIntentTypes.SaleIntent
          : fractionIntentTypes.SaleIntent;
        if (
          String(params?.[0]).toLowerCase() !== signer.address ||
          payload?.message?.seller?.toLowerCase() !== signer.address ||
          Number(payload?.domain?.chainId) !== fixture.chainId ||
          payload?.primaryType !== "SaleIntent" ||
          payload?.domain?.name !==
            (whole ? "ArtFi Whole Artwork Market" : "ArtFi Fractions Market") ||
          payload?.domain?.version !== "1" ||
          ![fixture.wholeMarket, fixture.fractionMarket].includes(market) ||
          JSON.stringify(payload?.types?.SaleIntent) !==
            JSON.stringify(expectedTypes)
        )
          throw new Error("Unexpected TEST_ONLY sale-signing request.");
        return signer.signTypedData(payload as TypedDataDefinition);
      }
      state.unexpectedWalletMethods++;
      throw new Error("Unsupported TEST_ONLY wallet method.");
    },
  );
  await page.addInitScript(
    ({ address, chainId }) => {
      const key = "TEST_ONLY_artfi_wallet_origin_permission";
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      let authorized = window.sessionStorage.getItem(key) === "granted";
      const emit = (event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((listener) => listener(...args));
      };
      const permissions = () => [
        {
          parentCapability: "eth_accounts",
          caveats: [{ type: "restrictReturnedAccounts", value: [address] }],
        },
      ];
      const permit = () => {
        authorized = true;
        window.sessionStorage.setItem(key, "granted");
        emit("accountsChanged", [address]);
        return permissions();
      };
      const provider = {
        isMetaMask: true,
        on(event: string, listener: (...args: unknown[]) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
        },
        async request({ method, params }: WalletRequest) {
          if (method === "eth_accounts") return authorized ? [address] : [];
          if (method === "eth_requestAccounts") {
            permit();
            return [address];
          }
          if (method === "wallet_requestPermissions") return permit();
          if (method === "wallet_getPermissions")
            return authorized ? permissions() : [];
          if (method === "wallet_revokePermissions") {
            authorized = false;
            window.sessionStorage.removeItem(key);
            emit("accountsChanged", []);
            return null;
          }
          if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
          if (method === "net_version") return String(chainId);
          if (method === "wallet_getCapabilities") return {};
          if (
            [
              "eth_sendTransaction",
              "eth_sendRawTransaction",
              "eth_signTransaction",
              "wallet_sendCalls",
            ].includes(method)
          )
            return (
              window as unknown as {
                TEST_ONLY_artfiWalletRequest: (
                  request: WalletRequest,
                ) => Promise<unknown>;
              }
            ).TEST_ONLY_artfiWalletRequest({ method, params });
          if (!authorized)
            throw new Error("Connect the TEST_ONLY wallet before signing.");
          return (
            window as unknown as {
              TEST_ONLY_artfiWalletRequest: (
                request: WalletRequest,
              ) => Promise<unknown>;
            }
          ).TEST_ONLY_artfiWalletRequest({ method, params });
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider });
    },
    { address: signer.address, chainId: fixture.chainId },
  );

  // Only synthetic read-only RPC is fulfilled. All auth/order HTTP crosses the real servers.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.webURL && url.origin !== fixture.apiURL) {
      state.blockedExternalRequests++;
      await route.abort("blockedbyclient");
      return;
    }
    if (
      url.origin !== fixture.webURL ||
      url.pathname !== "/TEST_ONLY-hoodi-rpc"
    ) {
      await route.continue();
      return;
    }
    const answer = (request: SessionRPCRequest) => {
      try {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: sessionRPCResult(request, signer.address),
        };
      } catch {
        state.unsupportedRPC++;
        // Keep only method and selector, never calldata, wallet data, cookies or keys.
        const method = /^[a-zA-Z0-9_]{1,80}$/.test(request.method)
          ? request.method
          : "invalid-method";
        const data = (request.params?.[0] as { data?: unknown } | undefined)
          ?.data;
        const selector =
          typeof data === "string" && /^0x[0-9a-f]{8}/i.test(data)
            ? data.slice(0, 10)
            : "no-selector";
        state.unsupportedRPCIdentifiers.add(`${method}:${selector}`);
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: "Unsupported TEST_ONLY read-only RPC.",
          },
        };
      }
    };
    const payload = route.request().postDataJSON();
    await route.fulfill({
      json: Array.isArray(payload) ? payload.map(answer) : answer(payload),
    });
  });
  return { state, address: signer.address, signedOrder: signer.signedOrder };
}

export function visibleButton(page: Page, name: string) {
  return page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .first();
}

export async function connectSessionWallet(page: Page) {
  await visibleButton(page, "Connect wallet").click();
  await page
    .getByRole("button", { name: /Browser Wallet|MetaMask|Injected/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.locator(".wallet-button--connected:visible").first(),
  ).toBeVisible();
}

export async function signInSessionWallet(page: Page) {
  const verified = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/user/auth/verify" &&
      response.request().method() === "POST",
  );
  await visibleButton(page, "Sign in").click();
  expect((await verified).status()).toBe(200);
  await expect(visibleButton(page, "Sign out")).toBeVisible();
  await expect(
    page
      .getByLabel("Wallet account session")
      .filter({ visible: true })
      .getByText("Signed in", { exact: true })
      .first(),
  ).toBeVisible();
  await seedSessionSourceCatalog(page);
}

export function assertReadOnlyWallet(
  state: Awaited<ReturnType<typeof installSessionWallet>>["state"],
) {
  expect(state.transactionAttempts).toBe(0);
  expect(state.unexpectedWalletMethods).toBe(0);
  expect(
    state.unsupportedRPC,
    `Unsupported TEST_ONLY RPC identifiers: ${[...state.unsupportedRPCIdentifiers].join(", ")}`,
  ).toBe(0);
}

/** Only public TEST_ONLY proof crosses the actual authenticated Next→Go boundary. */
async function seedSessionSourceCatalog(page: Page) {
  const statuses = await page.evaluate(async (publications) => {
    const sessionResponse = await fetch("/api/user/auth/session", {
      cache: "no-store",
    });
    const { session } = await sessionResponse.json();
    if (!sessionResponse.ok || !session)
      throw new Error(
        `The isolated source publisher has no session (HTTP ${sessionResponse.status}).`,
      );
    const statuses: number[] = [];
    for (const publication of publications) {
      const existing = await fetch(
        `/api/rwa/assets/${publication.asset.slug}`,
        { cache: "no-store" },
      );
      if (existing.status === 200) {
        const item = await existing.json();
        if (
          item.grounding?.mode !== "TEST_ONLY" ||
          item.grounding?.status !== "verified"
        )
          throw new Error("The isolated source fixture is not active.");
        statuses.push(200);
        continue;
      }
      if (existing.status !== 404)
        throw new Error("The isolated source catalog is unavailable.");
      const result = await fetch(
        `/api/rwa/publication/assets/${publication.asset.slug}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-artfi-wallet": session.address,
            "x-artfi-chain": String(session.chainId),
            "idempotency-key": `TEST_ONLY_source_${publication.asset.slug}`,
          },
          body: JSON.stringify(publication),
        },
      );
      statuses.push(result.status);
    }
    return statuses;
  }, sessionSourceFixture.publications);
  expect(statuses).toHaveLength(2);
  expect(statuses.every((status) => status === 200 || status === 201)).toBe(
    true,
  );
}
