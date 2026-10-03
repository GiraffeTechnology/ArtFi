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
  };
  readonly hostPermissions: {
    request(request: {
      permissions?: string[];
      origins?: string[];
    }): Promise<boolean>;
    remove(request: { origins?: string[] }): Promise<boolean>;
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

export async function loadGrants(deps: SiteAccessDeps): Promise<StoredGrant[]> {
  const stored = await deps.storage.get(SITE_GRANT_KEY);
  const raw = stored[SITE_GRANT_KEY];
  if (!Array.isArray(raw)) return [];
  const now = deps.now?.() ?? Date.now();
  return raw.filter((entry): entry is StoredGrant => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Partial<StoredGrant>;
    return (
      typeof candidate.origin === "string" &&
      Array.isArray(candidate.methods) &&
      typeof candidate.expiresAt === "number" &&
      candidate.expiresAt > now
    );
  });
}

async function persistGrants(
  deps: SiteAccessDeps,
  grants: StoredGrant[],
): Promise<void> {
  await deps.storage.set({ [SITE_GRANT_KEY]: grants });
}

/**
 * Enables one origin: asks for the optional permissions, registers the page scripts, records
 * the grant.
 *
 * The permission request comes first. If the person declines it, nothing is registered and
 * nothing is recorded, so a refusal leaves no half-enabled site behind.
 */
export async function enableSite(
  originValue: string,
  controller: PermissionController,
  deps: SiteAccessDeps,
): Promise<StoredGrant> {
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
  return grants[grants.length - 1] as StoredGrant;
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
 * Rebuilds in-memory grants after a service-worker restart, and unregisters scripts whose grant
 * has expired or gone.
 *
 * Without this the two states drift apart in the dangerous direction: scripts persist, grants do
 * not, so a page would keep a provider that answers every request with "not enabled".
 */
export async function restoreSiteAccess(
  controller: PermissionController,
  deps: SiteAccessDeps,
): Promise<StoredGrant[]> {
  const now = deps.now?.() ?? Date.now();
  const grants = await loadGrants(deps);
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
  await persistGrants(deps, grants);
  return grants;
}
