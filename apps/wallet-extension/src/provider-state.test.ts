import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionController } from "./permissions.js";
import { ProviderStateRelay, PROVIDER_STATE_PORT } from "./provider-state.js";
import * as rpc from "./rpc.js";
import type { VaultPayload } from "./vault.js";

const site = "https://io.artcch.com";
const address = "0x00112233445566778899aabbccddeeff00112233" as const;
const unlocked: VaultPayload = {
  accounts: [{ address, connector: "hardware", label: "Ledger" }],
  sessions: [],
  revision: 1,
};

function port(origin: string | undefined = site, name = PROVIDER_STATE_PORT) {
  let disconnected: ((port: ChromeRuntimePort) => void) | undefined;
  const value: ChromeRuntimePort = {
    name,
    sender: origin ? { origin } : undefined,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: {
      addListener: (listener) => {
        disconnected = listener;
      },
    },
  };
  return { value, close: () => disconnected?.(value) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(restored: Promise<unknown> = Promise.resolve()) {
  const permissions = new PermissionController();
  permissions.grant(site, ["eth_accounts"], Date.now(), 60_000);
  let payload: VaultPayload | null = unlocked;
  const relay = new ProviderStateRelay(
    { permissions, payload: () => payload },
    restored,
  );
  return {
    permissions,
    relay,
    lock: () => {
      payload = null;
    },
    unlock: () => {
      payload = unlocked;
    },
  };
}

function expectAccounts(
  connection: ReturnType<typeof port>,
  accounts: string[],
) {
  expect(connection.value.postMessage).toHaveBeenLastCalledWith({
    type: "provider.accountsChanged",
    accounts,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("provider account state relay", () => {
  it("publishes initial accounts, lock/unlock/revoke/re-enable and suppresses duplicates", async () => {
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    expectAccounts(connection, [address]);
    state.relay.refresh();
    await settle();
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
    state.lock();
    state.relay.refresh();
    await settle();
    expectAccounts(connection, []);
    state.unlock();
    state.relay.refresh();
    await settle();
    expectAccounts(connection, [address]);
    state.permissions.revoke(site);
    state.relay.refresh();
    await settle();
    expectAccounts(connection, []);
    state.permissions.grant(site, ["eth_accounts"]);
    state.relay.refresh();
    await settle();
    expectAccounts(connection, [address]);
    expect(connection.value.postMessage).toHaveBeenCalledTimes(5);
  });

  it("waits for restored permissions and uses only the browser's origin", async () => {
    const restored = deferred<void>();
    const state = setup(restored.promise);
    const connection = port("https://unapproved.example");
    const routing = vi.spyOn(rpc, "routeProviderRequest");
    state.relay.connect(connection.value);
    await settle();
    expect(routing).not.toHaveBeenCalled();
    restored.resolve();
    await settle();
    expectAccounts(connection, []);
    expect(routing.mock.calls[0]?.slice(0, 3)).toEqual([
      "https://unapproved.example",
      "eth_accounts",
      [],
    ]);
    expect(connection.value.onMessage.addListener).not.toHaveBeenCalled();
  });

  it("disconnects unknown senders, ignores unrelated ports and refuses unsafe origins", async () => {
    const state = setup();
    const missing = port("");
    state.relay.connect(missing.value);
    expect(missing.value.disconnect).toHaveBeenCalledOnce();
    const unrelated = port(site, "different-port");
    state.relay.connect(unrelated.value);
    const unsafe = port("http://untrusted.example");
    state.relay.connect(unsafe.value);
    await settle();
    expect(unrelated.value.postMessage).not.toHaveBeenCalled();
    expectAccounts(unsafe, []);
  });

  it("discards out-of-order snapshots after a lock refresh", async () => {
    const pending = deferred<unknown>();
    vi.spyOn(rpc, "routeProviderRequest").mockImplementationOnce(
      () => pending.promise,
    );
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    state.lock();
    state.relay.refresh();
    await settle();
    expectAccounts(connection, []);
    pending.resolve([address]);
    await settle();
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
  });

  it("rechecks payload and grants when mutation happens before a final refresh", async () => {
    const pending = deferred<unknown>();
    vi.spyOn(rpc, "routeProviderRequest").mockImplementationOnce(
      () => pending.promise,
    );
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    state.lock();
    pending.resolve([address]);
    await settle();
    expectAccounts(connection, []);
    state.unlock();
    const second = deferred<unknown>();
    vi.spyOn(rpc, "routeProviderRequest").mockImplementationOnce(
      () => second.promise,
    );
    state.relay.refresh();
    await settle();
    state.permissions.revoke(site);
    second.resolve([address]);
    await settle();
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
  });

  it("clears visible accounts exactly at grant expiry without another wallet action", async () => {
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    expectAccounts(connection, [address]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expectAccounts(connection, []);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish accounts from an answer that completes after expiry", async () => {
    const pending = deferred<unknown>();
    vi.spyOn(rpc, "routeProviderRequest").mockImplementationOnce(
      () => pending.promise,
    );
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    vi.setSystemTime(61_000);
    pending.resolve([address]);
    await settle();
    expectAccounts(connection, []);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes disconnected ports and clears expiry timers", async () => {
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    connection.close();
    expect(vi.getTimerCount()).toBe(0);
    state.lock();
    state.relay.refresh();
    await settle();
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
  });

  it("does not publish an in-flight snapshot after disconnect", async () => {
    const pending = deferred<unknown>();
    vi.spyOn(rpc, "routeProviderRequest").mockImplementationOnce(
      () => pending.promise,
    );
    const state = setup();
    const connection = port();
    state.relay.connect(connection.value);
    await settle();
    connection.close();
    pending.resolve([address]);
    await settle();
    expect(connection.value.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes a port if postMessage throws", async () => {
    const state = setup();
    const connection = port();
    vi.mocked(connection.value.postMessage).mockImplementation(() => {
      throw new Error("gone");
    });
    state.relay.connect(connection.value);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    state.relay.refresh();
    await settle();
    expect(connection.value.postMessage).toHaveBeenCalledTimes(1);
  });
});
