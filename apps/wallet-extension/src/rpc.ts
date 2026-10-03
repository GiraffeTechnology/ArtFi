import { assertSafeOrigin } from "./phishing.js";
import { PermissionController } from "./permissions.js";
import { SUPPORTED_CHAIN_ID } from "./transactions.js";
import type { VaultPayload } from "./vault.js";

/**
 * The page-facing request router.
 *
 * `permissions.ts` and `transactions.ts` already modelled per-origin EIP-1193 grants and
 * Hoodi-only confirmation, but nothing ever reached them: the service worker answered
 * `vault.*` messages only, and the extension had no page-facing surface at all. ArtFi's web
 * app accepts exactly one connector — `injectedWallet`, which needs an EIP-6963 announcement —
 * so no wallet in the ArtFi ecosystem could connect to ArtFi in production. This module is the
 * missing half: it turns a page request into an answer, or into an explicit refusal.
 *
 * Two rules govern everything here.
 *
 * The origin is never taken from the page. It arrives from `sender.origin`, which the browser
 * sets, because a page that could name its own origin could borrow another site's grant.
 *
 * Signing stays where it was. The vault holds account descriptors and no key material, and the
 * README's boundary is that an approved hardware or WalletConnect adapter is the only signer.
 * `ExternalSigner` has no implementation yet, so every signing method is refused by name rather
 * than answered with something that looks like a signature. Connecting works; signing says why
 * it does not.
 */

/** Reverse-DNS identity announced to pages. Stable: wallets are matched on it. */
export const PROVIDER_RDNS = "com.artcch.artfi";

/** EIP-1193 error codes used by this router. */
export const PROVIDER_ERROR = {
  unauthorized: 4100,
  unsupportedMethod: 4200,
  unrecognizedChain: 4902,
} as const;

export interface ProviderError extends Error {
  code: number;
}

export function providerError(code: number, message: string): ProviderError {
  const error = new Error(message) as ProviderError;
  error.code = code;
  return error;
}

export interface RpcContext {
  readonly permissions: PermissionController;
  /** The unlocked vault payload, or null while the coordinator is locked. */
  readonly payload: () => VaultPayload | null;
  readonly now?: () => number;
}

/**
 * Methods that would need a private key or an approved external signer. Listed explicitly,
 * including the legacy aliases, so a new alias cannot fall through to a generic handler.
 */
const signingMethods = new Set([
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v1",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]);

const chainIdHex = `0x${SUPPORTED_CHAIN_ID.toString(16)}`;

function grantedAccounts(context: RpcContext): `0x${string}`[] {
  const payload = context.payload();
  if (!payload) return [];
  return payload.accounts.map((account) => account.address);
}

function hasSiteGrant(
  origin: string,
  context: RpcContext,
  now: number,
): boolean {
  try {
    context.permissions.assert(origin, "eth_accounts", now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Answers one page request.
 *
 * `originValue` is the browser-reported origin of the requesting frame.
 */
export async function routeProviderRequest(
  originValue: string,
  method: string,
  params: unknown,
  context: RpcContext,
): Promise<unknown> {
  const now = context.now?.() ?? Date.now();

  let origin: string;
  try {
    origin = assertSafeOrigin(originValue);
  } catch (error) {
    // An origin this wallet refuses to talk to is unauthorized, not unsupported: the method
    // might be perfectly ordinary, the caller is not.
    throw providerError(
      PROVIDER_ERROR.unauthorized,
      error instanceof Error ? error.message : "origin is not permitted",
    );
  }

  // The chain is a constant for this wallet and discloses nothing about the user, so it is
  // answered before any grant check. wagmi reads it while building the connector, and refusing
  // it would break the connection before the user could ever authorize the site.
  if (method === "eth_chainId") return chainIdHex;

  if (method === "eth_accounts") {
    // EIP-1193: an unconnected provider reports no accounts rather than failing. wagmi probes
    // this on every page load, so a throw here would surface as a broken wallet.
    if (!hasSiteGrant(origin, context, now)) return [];
    return grantedAccounts(context);
  }

  if (method === "eth_requestAccounts") {
    if (!hasSiteGrant(origin, context, now)) {
      // A page must not be able to authorize itself. The grant is made by the person, in the
      // extension popup, for one origin at a time.
      throw providerError(
        PROVIDER_ERROR.unauthorized,
        "this site is not enabled for ArtFi Wallet; enable it in the extension popup first",
      );
    }
    const accounts = grantedAccounts(context);
    if (accounts.length === 0) {
      throw providerError(
        PROVIDER_ERROR.unauthorized,
        "the ArtFi Wallet coordinator is locked or holds no account; unlock it in the extension popup",
      );
    }
    return accounts;
  }

  if (method === "wallet_switchEthereumChain") {
    // Answered rather than ignored: wagmi calls it when the page wants a chain the wallet is
    // not on, and a silent success would leave the page believing it had switched.
    const target = Array.isArray(params)
      ? (params[0] as { chainId?: unknown } | undefined)
      : undefined;
    if (target?.chainId === chainIdHex) return null;
    throw providerError(
      PROVIDER_ERROR.unrecognizedChain,
      `ArtFi Wallet Alpha is on Hoodi ${SUPPORTED_CHAIN_ID} only`,
    );
  }

  if (signingMethods.has(method)) {
    throw providerError(
      PROVIDER_ERROR.unsupportedMethod,
      `${method} needs an approved hardware or WalletConnect signer, which this alpha does not yet configure`,
    );
  }

  throw providerError(
    PROVIDER_ERROR.unsupportedMethod,
    `${method} is not supported by ArtFi Wallet Alpha`,
  );
}
