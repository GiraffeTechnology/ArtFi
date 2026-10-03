import { PermissionController } from "./permissions.js";
import { routeProviderRequest, type ProviderError } from "./rpc.js";
import {
  disableSite,
  enableSite,
  loadGrants,
  restoreSiteAccess,
  type SiteAccessDeps,
} from "./site-access.js";
import {
  openVault,
  sealVault,
  type EncryptedVault,
  type VaultPayload,
} from "./vault.js";

const vaultKey = "artfiEncryptedVault";
let unlockedPayload: VaultPayload | null = null;

const permissions = new PermissionController();

const siteAccess: SiteAccessDeps = {
  storage: chrome.storage.local,
  scripting: chrome.scripting,
  hostPermissions: chrome.permissions,
};

type WalletMessage =
  | { type: "vault.status" }
  | { type: "vault.create"; password: string; payload: VaultPayload }
  | { type: "vault.unlock"; password: string }
  | { type: "vault.lock" }
  | { type: "provider.request"; method: string; params?: unknown }
  | { type: "site.enable"; origin: string }
  | { type: "site.disable"; origin: string }
  | { type: "site.list" };

/**
 * Only the extension's own pages may administer grants.
 *
 * Everything else arriving here came from a content script in some website, and a site that could
 * call `site.enable` would be authorizing itself — which is the one thing the popup exists to
 * prevent.
 */
function isExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === "string" && origin.startsWith("chrome-extension://");
}

async function handleMessage(
  message: WalletMessage,
  senderOrigin: string | undefined,
): Promise<unknown> {
  if (message.type === "provider.request") {
    // The origin is the browser's account of who is asking, never the page's.
    if (!senderOrigin) throw new Error("the requesting origin is unknown");
    return routeProviderRequest(senderOrigin, message.method, message.params, {
      permissions,
      payload: () => unlockedPayload,
    });
  }

  if (
    message.type === "site.enable" ||
    message.type === "site.disable" ||
    message.type === "site.list"
  ) {
    if (!isExtensionOrigin(senderOrigin)) {
      throw new Error("site access is administered from the extension only");
    }
    if (message.type === "site.enable") {
      const grant = await enableSite(message.origin, permissions, siteAccess);
      return { grants: await loadGrants(siteAccess), granted: grant };
    }
    if (message.type === "site.disable") {
      await disableSite(message.origin, permissions, siteAccess);
      return { grants: await loadGrants(siteAccess) };
    }
    return { grants: await loadGrants(siteAccess) };
  }

  if (message.type === "vault.status") {
    const local = await chrome.storage.local.get(vaultKey);
    return {
      configured: Boolean(local[vaultKey]),
      locked: unlockedPayload === null,
    };
  }
  if (message.type === "vault.create") {
    const encrypted = await sealVault(message.payload, message.password);
    await chrome.storage.local.set({ [vaultKey]: encrypted });
    unlockedPayload = null;
    return { configured: true, locked: true };
  }
  if (message.type === "vault.unlock") {
    const stored = await chrome.storage.local.get(vaultKey);
    const encrypted = stored[vaultKey] as EncryptedVault | undefined;
    if (!encrypted) throw new Error("encrypted vault is not configured");
    const payload = await openVault(encrypted, message.password);
    unlockedPayload = payload;
    return { configured: true, locked: false, accounts: payload.accounts };
  }
  unlockedPayload = null;
  return { configured: true, locked: true };
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    void handleMessage(message as WalletMessage, sender.origin)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "wallet error",
          // Carried so the page provider can reject with a real EIP-1193 code instead of a
          // generic failure the app cannot act on.
          code: (error as ProviderError | undefined)?.code,
        }),
      );
    return true;
  },
);

// Registered content scripts outlive the service worker; in-memory grants do not. Rehydrate one
// from the other at every startup so a page never meets a provider that disowns its grant.
void restoreSiteAccess(permissions, siteAccess);
