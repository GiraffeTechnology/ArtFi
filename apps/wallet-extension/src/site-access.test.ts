import { describe, expect, it } from "vitest";

import { PermissionController } from "./permissions.js";
import {
  disableSite,
  enableSite,
  loadGrants,
  originMatchPattern,
  restoreSiteAccess,
  SITE_GRANT_KEY,
  type SiteAccessDeps,
} from "./site-access.js";

const site = "https://io.artcch.com";

interface RegisteredFields {
  world?: "MAIN" | "ISOLATED";
  js?: string[];
  matches?: string[];
}

interface Harness {
  deps: SiteAccessDeps;
  store: Record<string, unknown>;
  registered: Map<string, RegisteredFields>;
  requests: { permissions?: string[]; origins?: string[] }[];
  removals: { origins?: string[] }[];
}

function harness(options: { allow?: boolean; now?: number } = {}): Harness {
  const store: Record<string, unknown> = {};
  const registered = new Map<string, RegisteredFields>();
  const requests: { permissions?: string[]; origins?: string[] }[] = [];
  const removals: { origins?: string[] }[] = [];
  const deps: SiteAccessDeps = {
    storage: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (items) => {
        Object.assign(store, items);
      },
    },
    scripting: {
      registerContentScripts: async (scripts) => {
        for (const script of scripts) {
          registered.set(script.id, {
            world: script.world,
            js: script.js,
            matches: script.matches,
          });
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) registered.delete(id);
      },
      getRegisteredContentScripts: async () =>
        [...registered.entries()].map(([id, value]) => ({ id, ...value })),
    },
    hostPermissions: {
      request: async (request) => {
        requests.push(request);
        return options.allow !== false;
      },
      remove: async (request) => {
        removals.push(request);
        return true;
      },
    },
    now: () => options.now ?? 1_000,
  };
  return { deps, store, registered, requests, removals };
}

describe("per-origin page access", () => {
  it("narrows a grant to one origin's pattern", () => {
    expect(originMatchPattern("https://io.artcch.com/portfolio")).toBe(
      "https://io.artcch.com/*",
    );
    expect(() => originMatchPattern("http://io.artcch.com")).toThrow(/HTTPS/);
  });

  it("asks for permission, then registers both worlds and records the grant", async () => {
    const { deps, registered, requests, store } = harness();
    const controller = new PermissionController();
    const grant = await enableSite(site, controller, deps);

    expect(requests).toEqual([
      { permissions: ["scripting"], origins: ["https://io.artcch.com/*"] },
    ]);
    // The provider must reach the page's own world or no EIP-6963 announcement is visible;
    // only the isolated world may speak to the service worker.
    expect(registered.get(`artfi-provider:${site}`)).toEqual({
      world: "MAIN",
      js: ["provider.js"],
      matches: ["https://io.artcch.com/*"],
    });
    expect(registered.get(`artfi-bridge:${site}`)).toEqual({
      world: "ISOLATED",
      js: ["bridge.js"],
      matches: ["https://io.artcch.com/*"],
    });
    expect(grant.origin).toBe(site);
    expect(store[SITE_GRANT_KEY]).toHaveLength(1);
    expect(controller.assert(site, "eth_accounts", 1_000).origin).toBe(site);
  });

  it("leaves nothing half-enabled when the person declines", async () => {
    const { deps, registered, store } = harness({ allow: false });
    const controller = new PermissionController();
    await expect(enableSite(site, controller, deps)).rejects.toThrow(
      /not granted/,
    );
    expect(registered.size).toBe(0);
    expect(store[SITE_GRANT_KEY]).toBeUndefined();
    expect(() => controller.assert(site, "eth_accounts", 1_000)).toThrow();
  });

  it("enabling twice does not duplicate a registration", async () => {
    const { deps, registered } = harness();
    const controller = new PermissionController();
    await enableSite(site, controller, deps);
    await enableSite(site, controller, deps);
    expect(registered.size).toBe(2);
    expect(await loadGrants(deps)).toHaveLength(1);
  });

  it("disabling removes the scripts, the grant and the host permission", async () => {
    const { deps, registered, removals } = harness();
    const controller = new PermissionController();
    await enableSite(site, controller, deps);
    await disableSite(site, controller, deps);

    expect(registered.size).toBe(0);
    expect(await loadGrants(deps)).toEqual([]);
    expect(() => controller.assert(site, "eth_accounts", 1_000)).toThrow();
    // A disabled site must not stay reachable by the extension.
    expect(removals).toEqual([{ origins: ["https://io.artcch.com/*"] }]);
  });

  it("rehydrates in-memory grants that a worker restart discarded", async () => {
    // Registered scripts survive a restart and grants do not. Without this the page would meet
    // a provider that refuses its own grant.
    const { deps } = harness();
    const first = new PermissionController();
    await enableSite(site, first, deps);

    const afterRestart = new PermissionController();
    expect(() => afterRestart.assert(site, "eth_accounts", 1_000)).toThrow();
    await restoreSiteAccess(afterRestart, deps);
    expect(afterRestart.assert(site, "eth_accounts", 1_000).origin).toBe(site);
  });

  it("unregisters scripts whose grant has expired", async () => {
    const { deps, registered, store } = harness();
    const controller = new PermissionController();
    await enableSite(site, controller, deps);
    // Age the stored grant past its expiry.
    store[SITE_GRANT_KEY] = [
      {
        origin: site,
        methods: ["eth_accounts"],
        approvedAt: 0,
        expiresAt: 500,
      },
    ];

    const restored = await restoreSiteAccess(new PermissionController(), deps);
    expect(restored).toEqual([]);
    expect(registered.size).toBe(0);
  });

  it("ignores a malformed stored grant", async () => {
    const { deps, store } = harness();
    store[SITE_GRANT_KEY] = [
      null,
      "https://io.artcch.com",
      { origin: site },
      {
        origin: site,
        methods: ["eth_accounts"],
        approvedAt: 0,
        expiresAt: 9_000,
      },
    ];
    expect(await loadGrants(deps)).toEqual([
      {
        origin: site,
        methods: ["eth_accounts"],
        approvedAt: 0,
        expiresAt: 9_000,
      },
    ]);
  });
});
