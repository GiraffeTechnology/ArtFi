import { ProviderStateRelay } from "./provider-state.js";
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
  tabs: chrome.tabs,
};

/**
 * Registered content scripts outlive the service worker; in-memory grants do not. Chrome restarts
 * this worker to deliver an event, so a provider request can arrive while storage is still being
 * read — and an unawaited restoration would let that first request be refused as unauthorized and
 * a retry succeed, which is the worst shape a permission check can have. Every handler that reads
 * a grant awaits this promise, and it is started once here rather than per message.
 */
const siteAccessRestored = restoreSiteAccess(permissions, siteAccess).catch(
  () => [],
);

const providerState = new ProviderStateRelay(
  { permissions, payload: () => unlockedPayload },
  siteAccessRestored,
);
chrome.runtime.onConnect.addListener((port) => providerState.connect(port));

type WalletMessage =
  | { type: "vault.status" }
  | { type: "vault.create"; password: string; payload: VaultPayload }
  | { type: "vault.unlock"; password: string }
  | { type: "vault.lock" }
  | { type: "provider.request"; method: string; params?: unknown }
  | { type: "site.enable"; origin: string; tabId?: number }
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
    // Grants must be back in memory before the first request is judged.
    await siteAccessRestored;
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
    await siteAccessRestored;
    if (message.type === "site.enable") {
      try {
        const grant = await enableSite(
          message.origin,
          permissions,
          siteAccess,
          message.tabId,
        );
        return { grants: await loadGrants(siteAccess), granted: grant };
      } finally {
        // Grant mutation may precede a storage/injection failure.
        providerState.refresh();
      }
    }
    if (message.type === "site.disable") {
      try {
        await disableSite(message.origin, permissions, siteAccess);
        return { grants: await loadGrants(siteAccess) };
      } finally {
        providerState.refresh();
      }
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
    providerState.refresh();
    return { configured: true, locked: true };
  }
  if (message.type === "vault.unlock") {
    const stored = await chrome.storage.local.get(vaultKey);
    const encrypted = stored[vaultKey] as EncryptedVault | undefined;
    if (!encrypted) throw new Error("encrypted vault is not configured");
    const payload = await openVault(encrypted, message.password);
    unlockedPayload = payload;
    providerState.refresh();
    return { configured: true, locked: false, accounts: payload.accounts };
  }
  unlockedPayload = null;
  providerState.refresh();
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
