import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionController } from "./permissions.js";
import type { VaultPayload } from "./vault.js";

const fixtures = vi.hoisted(() => ({
  site: "https://io.artcch.com",
  payload: {
    accounts: [
      {
        address: "0x00112233445566778899aabbccddeeff00112233",
        connector: "hardware",
        label: "Ledger",
      },
    ],
    sessions: [],
    revision: 1,
  } as VaultPayload,
  failDisable: false,
}));

vi.mock("./vault.js", () => ({
  openVault: vi.fn(async () => fixtures.payload),
  sealVault: vi.fn(async () => ({ encrypted: true })),
}));
vi.mock("./site-access.js", () => ({
  restoreSiteAccess: vi.fn(async (permissions: PermissionController) => {
    permissions.grant(fixtures.site, ["eth_accounts"]);
    return [];
  }),
  loadGrants: vi.fn(async () => []),
  enableSite: vi.fn(async (origin: string, permissions: PermissionController) =>
    permissions.grant(origin, ["eth_accounts"]),
  ),
  disableSite: vi.fn(
    async (origin: string, permissions: PermissionController) => {
      permissions.revoke(origin);
      if (fixtures.failDisable) throw new Error("storage unavailable");
    },
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fixtures.failDisable = false;
});

describe("background account lifecycle wiring", () => {
  it("refreshes connected pages on unlock, lock, create, disable, enable and partial revoke failure", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let onConnect!: (port: ChromeRuntimePort) => void;
    let onMessage!: Parameters<ChromeRuntime["onMessage"]["addListener"]>[0];
    vi.stubGlobal("chrome", {
      runtime: {
        onConnect: {
          addListener: (listener: typeof onConnect) => {
            onConnect = listener;
          },
        },
        onMessage: {
          addListener: (listener: typeof onMessage) => {
            onMessage = listener;
          },
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({
            artfiEncryptedVault: { encrypted: true },
          })),
          set: vi.fn(async () => {}),
        },
      },
      scripting: {},
      permissions: {},
      tabs: {},
    });
    await import("./background.js");
    const messages: unknown[] = [];
    const connection: ChromeRuntimePort = {
      name: "artfi-provider-state",
      sender: { origin: fixtures.site },
      postMessage: (message) => {
        messages.push(message);
      },
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    };
    onConnect(connection);
    async function settle() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    const send = async (message: unknown) => {
      const response = await new Promise<unknown>((resolve) => {
        onMessage(message, { origin: "chrome-extension://test" }, resolve);
      });
      await settle();
      return response;
    };
    const lastAccounts = () =>
      (messages.at(-1) as { accounts: string[] }).accounts;
    await settle();
    expect(lastAccounts()).toEqual([]);
    await send({ type: "vault.unlock", password: "test" });
    expect(lastAccounts()).toEqual([fixtures.payload.accounts[0]!.address]);
    await send({ type: "vault.lock" });
    expect(lastAccounts()).toEqual([]);
    await send({ type: "vault.unlock", password: "test" });
    await send({
      type: "vault.create",
      password: "test",
      payload: fixtures.payload,
    });
    expect(lastAccounts()).toEqual([]);
    await send({ type: "vault.unlock", password: "test" });
    await send({ type: "site.disable", origin: fixtures.site });
    expect(lastAccounts()).toEqual([]);
    await send({ type: "site.enable", origin: fixtures.site });
    expect(lastAccounts()).toEqual([fixtures.payload.accounts[0]!.address]);
    fixtures.failDisable = true;
    expect(
      await send({ type: "site.disable", origin: fixtures.site }),
    ).toMatchObject({ ok: false });
    expect(lastAccounts()).toEqual([]);
  });
});
