import { assertSafeOrigin } from "./phishing.js";
import { PermissionController, type WalletMethod } from "./permissions.js";

/**
 * Per-origin page access.
 *
 * The manifest grants no host access by default, and the README makes that a property of the
 * product rather than an oversight: script and host access are optional permissions a person
 * grants explicitly. A static `content_scripts` block matching every HTTPS site would have
 * traded that away for convenience, so the page provider is registered at run time, for one
 * origin, only after the person enables that origin in the popup.
 *
 * `PermissionController` keeps grants in memory, which a service-worker restart would discard.
 * Registered content scripts, by contrast, survive a restart. Left alone those two would
 * disagree — a page would still see a provider that no longer recognised its grant — so the
 * grants are also persisted here and rehydrated on startup. The vault stays memory-only: a
 * grant records which origin may ask, never anything that could sign.
 */

export const SITE_GRANT_KEY = "artfiSiteGrants";

/** Methods a site grant covers. Signing is refused by the router regardless. */
export const SITE_GRANT_METHODS: WalletMethod[] = [
  "eth_accounts",
  "eth_chainId",
];

const PROVIDER_SCRIPT_ID = "artfi-provider";
const BRIDGE_SCRIPT_ID = "artfi-bridge";

export interface StoredGrant {
  origin: string;
  methods: WalletMethod[];
  approvedAt: number;
  expiresAt: number;
}

interface RegisteredScript {
  id: string;
  matches?: string[];
  js?: string[];
  world?: "MAIN" | "ISOLATED";
  runAt?: string;
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

export interface SiteAccessDeps {
  readonly storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  readonly scripting: {
    registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts(): Promise<RegisteredScript[]>;
    executeScript(injection: {
      target: { tabId: number };
      files: string[];
      world?: "MAIN" | "ISOLATED";
    }): Promise<unknown>;
  };
  readonly hostPermissions: {
    request(request: {
      permissions?: string[];
      origins?: string[];
    }): Promise<boolean>;
    remove(request: { origins?: string[] }): Promise<boolean>;
  };
  readonly tabs: {
    get(tabId: number): Promise<{ url?: string }>;
  };
  readonly now?: () => number;
}

/** `https://example.com` becomes `https://example.com/*`, the narrowest useful pattern. */
export function originMatchPattern(origin: string): string {
  return `${assertSafeOrigin(origin)}/*`;
}

function scriptIds(origin: string): { provider: string; bridge: string } {
  return {
    provider: `${PROVIDER_SCRIPT_ID}:${origin}`,
    bridge: `${BRIDGE_SCRIPT_ID}:${origin}`,
  };
}

function wellFormed(entry: unknown): entry is StoredGrant {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as Partial<StoredGrant>;
  return (
    typeof candidate.origin === "string" &&
    Array.isArray(candidate.methods) &&
    typeof candidate.expiresAt === "number"
  );
}

/**
 * Reads stored grants and separates the live from the expired.
 *
 * The expired ones are returned rather than simply dropped, because an expired grant still has a
 * host permission attached to it that has to be handed back.
 */
export async function partitionGrants(
  deps: SiteAccessDeps,
): Promise<{ live: StoredGrant[]; expired: StoredGrant[] }> {
  const stored = await deps.storage.get(SITE_GRANT_KEY);
  const raw = stored[SITE_GRANT_KEY];
  if (!Array.isArray(raw)) return { live: [], expired: [] };
  const now = deps.now?.() ?? Date.now();
  const live: StoredGrant[] = [];
  const expired: StoredGrant[] = [];
  for (const entry of raw) {
    if (!wellFormed(entry)) continue;
    (entry.expiresAt > now ? live : expired).push(entry);
  }
  return { live, expired };
}

export async function loadGrants(deps: SiteAccessDeps): Promise<StoredGrant[]> {
  return (await partitionGrants(deps)).live;
}

async function persistGrants(
  deps: SiteAccessDeps,
  grants: StoredGrant[],
): Promise<void> {
  await deps.storage.set({ [SITE_GRANT_KEY]: grants });
}

/**
 * Runs the page scripts in a tab that is already open.
 *
 * `registerContentScripts` only applies to later document loads, so without this the person
 * enables the site, nothing happens, and the provider appears only if they happen to reload.
 * Injection is per tab, so the tab is verified to be on the granted origin first: the tab id comes
 * from the popup, and a tab that has navigated elsewhere in the meantime must not receive it.
 *
 * Failure here is not fatal. The registration still stands and the next load will carry the
 * provider, so the caller reports whether a reload is needed rather than undoing the grant.
 */
async function injectIntoOpenTab(
  origin: string,
  tabId: number,
  deps: SiteAccessDeps,
): Promise<boolean> {
  try {
    const tab = await deps.tabs.get(tabId);
    if (!tab.url) return false;
    if (new URL(tab.url).origin !== origin) return false;
    // Same order and worlds as the registration, so an injected tab behaves like a loaded one.
    await deps.scripting.executeScript({
      target: { tabId },
      files: ["provider.js"],
      world: "MAIN",
    });
    await deps.scripting.executeScript({
      target: { tabId },
      files: ["bridge.js"],
      world: "ISOLATED",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enables one origin: asks for the optional permissions, registers the page scripts, records
 * the grant, and runs the scripts in the tab that is already open.
 *
 * The permission request comes first. If the person declines it, nothing is registered and
 * nothing is recorded, so a refusal leaves no half-enabled site behind.
 */
export async function enableSite(
  originValue: string,
  controller: PermissionController,
  deps: SiteAccessDeps,
  tabId?: number,
): Promise<StoredGrant & { injected: boolean }> {
  const origin = assertSafeOrigin(originValue);
  const granted = await deps.hostPermissions.request({
    permissions: ["scripting"],
    origins: [originMatchPattern(origin)],
  });
  if (!granted) throw new Error("site access was not granted");

  const ids = scriptIds(origin);
  const existing = await deps.scripting.getRegisteredContentScripts();
  const alreadyRegistered = new Set(existing.map((script) => script.id));
  const pending: RegisteredScript[] = [];
  if (!alreadyRegistered.has(ids.provider)) {
    pending.push({
      id: ids.provider,
      matches: [originMatchPattern(origin)],
      js: ["provider.js"],
      // The page's own world: an EIP-6963 announcement has to be visible to page scripts.
      world: "MAIN",
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    });
  }
  if (!alreadyRegistered.has(ids.bridge)) {
    pending.push({
      id: ids.bridge,
      matches: [originMatchPattern(origin)],
      js: ["bridge.js"],
      // Isolated: only this world may speak to the service worker.
      world: "ISOLATED",
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    });
  }
  if (pending.length > 0) await deps.scripting.registerContentScripts(pending);

  const now = deps.now?.() ?? Date.now();
  const record = controller.grant(origin, SITE_GRANT_METHODS, now);
  const grants = (await loadGrants(deps)).filter(
    (grant) => grant.origin !== origin,
  );
  grants.push({
    origin: record.origin,
    methods: record.methods,
    approvedAt: record.approvedAt,
    expiresAt: record.expiresAt,
  });
  await persistGrants(deps, grants);

  // After the grant exists, not before: an injected provider whose first request would be refused
  // is worse than one that arrives a moment later.
  const injected =
    tabId === undefined ? false : await injectIntoOpenTab(origin, tabId, deps);

  return {
    ...(grants[grants.length - 1] as StoredGrant),
    injected,
  };
}

/** Disables one origin and leaves nothing of it behind. */
export async function disableSite(
  originValue: string,
  controller: PermissionController,
  deps: SiteAccessDeps,
): Promise<void> {
  const origin = assertSafeOrigin(originValue);
  const ids = scriptIds(origin);
  const existing = await deps.scripting.getRegisteredContentScripts();
  const present = existing
    .map((script) => script.id)
    .filter((id) => id === ids.provider || id === ids.bridge);
  if (present.length > 0) {
    await deps.scripting.unregisterContentScripts({ ids: present });
  }
  controller.revoke(origin);
  const grants = (await loadGrants(deps)).filter(
    (grant) => grant.origin !== origin,
  );
  await persistGrants(deps, grants);
  // Hand the host permission back, so a disabled site is not left reachable.
  await deps.hostPermissions.remove({ origins: [originMatchPattern(origin)] });
}

/**
 * Rebuilds in-memory grants after a service-worker restart, unregisters scripts whose grant has
 * expired or gone, and hands back the host permission of every grant that expired.
 *
 * Without the rehydration the two states drift apart in the dangerous direction: scripts persist,
 * grants do not, so a page would keep a provider that answers every request with "not enabled".
 *
 * The permission revocation closes the opposite drift. Expiry used to drop a grant from storage
 * and unregister its scripts while leaving the optional host permission in place, so an origin
 * that had disappeared from the popup's list stayed authorized in the browser indefinitely. An
 * expired grant now gives its host access back, exactly as an explicit disable does.
 */
export async function restoreSiteAccess(
  controller: PermissionController,
  deps: SiteAccessDeps,
): Promise<StoredGrant[]> {
  const now = deps.now?.() ?? Date.now();
  const { live: grants, expired } = await partitionGrants(deps);
  const live = new Set<string>();
  for (const grant of grants) {
    try {
      controller.grant(
        grant.origin,
        grant.methods,
        now,
        Math.max(grant.expiresAt - now, 60_000),
      );
      live.add(scriptIds(grant.origin).provider);
      live.add(scriptIds(grant.origin).bridge);
    } catch {
      // A grant that no longer validates is dropped rather than repaired.
    }
  }
  const registered = await deps.scripting.getRegisteredContentScripts();
  const stale = registered
    .map((script) => script.id)
    .filter(
      (id) =>
        (id.startsWith(`${PROVIDER_SCRIPT_ID}:`) ||
          id.startsWith(`${BRIDGE_SCRIPT_ID}:`)) &&
        !live.has(id),
    );
  if (stale.length > 0) {
    await deps.scripting.unregisterContentScripts({ ids: stale });
  }

  // Only origins that have no surviving grant: a re-enabled origin may appear in both lists, and
  // revoking its host access would break the grant that is still live.
  const stillGranted = new Set(grants.map((grant) => grant.origin));
  const abandoned = [
    ...new Set(
      expired
        .map((grant) => grant.origin)
        .filter((origin) => !stillGranted.has(origin)),
    ),
  ];
  for (const origin of abandoned) {
    try {
      await deps.hostPermissions.remove({
        origins: [originMatchPattern(origin)],
      });
    } catch {
      // A revocation the browser refuses must not abort the restoration of the live grants.
    }
  }

  await persistGrants(deps, grants);
  return grants;
}
