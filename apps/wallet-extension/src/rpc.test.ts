import { describe, expect, it } from "vitest";

import { PermissionController } from "./permissions.js";
import {
  PROVIDER_ERROR,
  routeProviderRequest,
  type ProviderError,
  type RpcContext,
} from "./rpc.js";
import { SUPPORTED_CHAIN_ID } from "./transactions.js";
import type { VaultPayload } from "./vault.js";

const site = "https://io.artcch.com";
const account = "0x00112233445566778899aabbccddeeff00112233" as const;

function unlocked(): VaultPayload {
  return {
    accounts: [{ address: account, connector: "hardware", label: "Ledger" }],
    sessions: [],
    revision: 1,
  };
}

function context(
  overrides: Partial<RpcContext> & { granted?: boolean; locked?: boolean } = {},
): RpcContext {
  const permissions = new PermissionController();
  if (overrides.granted !== false) {
    permissions.grant(site, ["eth_accounts", "eth_chainId"], 1_000, 60_000);
  }
  return {
    permissions,
    payload: () => (overrides.locked ? null : unlocked()),
    now: () => 1_000,
    ...(overrides.permissions ? { permissions: overrides.permissions } : {}),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as ProviderError).code;
  }
}

describe("page provider request routing", () => {
  it("answers the chain before any grant exists", async () => {
    // wagmi reads the chain while constructing the connector. Requiring a grant first would
    // deadlock the connection the grant is meant to enable.
    await expect(
      routeProviderRequest(
        site,
        "eth_chainId",
        [],
        context({ granted: false }),
      ),
    ).resolves.toBe(`0x${SUPPORTED_CHAIN_ID.toString(16)}`);
  });

  it("reports no accounts for an unenabled site instead of failing", async () => {
    // EIP-1193 treats "not connected" as an empty account list. Throwing would make every
    // page load look like a broken wallet.
    await expect(
      routeProviderRequest(
        site,
        "eth_accounts",
        [],
        context({ granted: false }),
      ),
    ).resolves.toEqual([]);
  });

  it("returns the account to an enabled site", async () => {
    await expect(
      routeProviderRequest(site, "eth_accounts", [], context()),
    ).resolves.toEqual([account]);
    await expect(
      routeProviderRequest(site, "eth_requestAccounts", [], context()),
    ).resolves.toEqual([account]);
  });

  it("refuses to let a page enable itself", async () => {
    // The grant is made by a person in the popup. If eth_requestAccounts could create one,
    // the popup would be decoration.
    expect(
      await codeOf(
        routeProviderRequest(
          site,
          "eth_requestAccounts",
          [],
          context({ granted: false }),
        ),
      ),
    ).toBe(PROVIDER_ERROR.unauthorized);
  });

  it("refuses an account read while the coordinator is locked", async () => {
    expect(
      await codeOf(
        routeProviderRequest(
          site,
          "eth_requestAccounts",
          [],
          context({ locked: true }),
        ),
      ),
    ).toBe(PROVIDER_ERROR.unauthorized);
  });

  it("refuses an origin the phishing policy rejects", async () => {
    expect(
      await codeOf(
        routeProviderRequest(
          "http://io.artcch.com",
          "eth_chainId",
          [],
          context(),
        ),
      ),
    ).toBe(PROVIDER_ERROR.unauthorized);
    expect(
      await codeOf(
        routeProviderRequest(
          "https://xn--artf-epa.test",
          "eth_chainId",
          [],
          context(),
        ),
      ),
    ).toBe(PROVIDER_ERROR.unauthorized);
  });

  it("refuses every signing method by name rather than answering it", async () => {
    // The vault holds no key material and no ExternalSigner is configured. A plausible-looking
    // answer here would be a fabricated signature.
    for (const method of [
      "eth_sendTransaction",
      "eth_signTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData",
      "eth_signTypedData_v1",
      "eth_signTypedData_v3",
      "eth_signTypedData_v4",
    ]) {
      const promise = routeProviderRequest(site, method, [], context());
      expect(await codeOf(promise)).toBe(PROVIDER_ERROR.unsupportedMethod);
      await expect(promise).rejects.toThrow(
        /approved hardware or WalletConnect signer/,
      );
    }
  });

  it("accepts a switch to its own chain and rejects any other", async () => {
    const chainId = `0x${SUPPORTED_CHAIN_ID.toString(16)}`;
    await expect(
      routeProviderRequest(
        site,
        "wallet_switchEthereumChain",
        [{ chainId }],
        context(),
      ),
    ).resolves.toBeNull();
    expect(
      await codeOf(
        routeProviderRequest(
          site,
          "wallet_switchEthereumChain",
          [{ chainId: "0x1" }],
          context(),
        ),
      ),
    ).toBe(PROVIDER_ERROR.unrecognizedChain);
  });

  it("rejects an unknown method", async () => {
    expect(
      await codeOf(routeProviderRequest(site, "eth_coinbase", [], context())),
    ).toBe(PROVIDER_ERROR.unsupportedMethod);
  });

  it("keeps one site's grant from reaching another origin", async () => {
    // The service worker takes the origin from sender.origin for exactly this reason; this
    // asserts the router honours it rather than treating any grant as global.
    await expect(
      routeProviderRequest(
        "https://attacker.test",
        "eth_accounts",
        [],
        context(),
      ),
    ).resolves.toEqual([]);
  });
});
