import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientSessionController,
  ClientSessionError,
  serializeUserCookieMutation,
  subscribeToUserSessionChanges,
  type SessionAPI,
} from "./user-session-client";
const address = "0x1234567890123456789012345678901234567890";
const other = "0x2234567890123456789012345678901234567890";
const chainId = 560048;
const session = () => ({
  id: "session-one",
  address,
  chainId,
  expiresAt: Date.now() + 60_000,
  accessExpiresAt: Date.now() + 30_000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function setup(
  overrides: Partial<
    Record<Parameters<SessionAPI>[0], () => Promise<unknown>>
  > = {},
) {
  const calls: string[] = [];
  const api: SessionAPI = vi.fn(async (action: Parameters<SessionAPI>[0]) => {
    calls.push(action);
    if (overrides[action]) return overrides[action]!();
    if (action === "challenge")
      return {
        address,
        chainId,
        message: "Wallet login challenge",
        expiresAt: Date.now() + 60_000,
      };
    if (action === "logout") return { session: null };
    return { session: session() };
  });
  const controller = new ClientSessionController(api);
  controller.setWallet({ address, chainId, status: "connected" });
  return { api, controller, calls };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wallet session controller", () => {
  it("restores once and revalidates expired access through refresh without a signature or revision change", async () => {
    let first = true;
    const { controller, calls } = setup({
      session: async () => {
        if (first) {
          first = false;
          throw new ClientSessionError(401, "Expired");
        }
        return { session: session() };
      },
    });
    const left = controller.restore();
    expect(controller.restore()).toBe(left);
    await left;
    expect(calls).toEqual(["session", "refresh"]);
    const revision = controller.getSnapshot().revision;
    await controller.assertTradingSession(address, chainId);
    expect(controller.getSnapshot().revision).toBe(revision);
    expect(calls).toEqual(["session", "refresh", "session"]);
  });
  it("does not hold the cookie lock during a wallet prompt and never verifies a cancelled signature", async () => {
    const signature = deferred<`0x${string}`>();
    const { controller, calls } = setup();
    const signing = controller.signIn(() => signature.promise);
    await tick();
    expect(calls).toEqual(["challenge"]);
    await controller.cancel();
    expect(calls).toEqual(["challenge", "logout"]);
    signature.resolve("0xab");
    await signing;
    expect(calls).not.toContain("verify");
    expect(controller.getSnapshot().session).toBeNull();
  });
  it("revokes late verification before allowing another challenge to write cookies", async () => {
    const verification = deferred<unknown>();
    const { controller, calls } = setup({ verify: () => verification.promise });
    const oldSignIn = controller.signIn(async () => "0xab");
    await tick();
    expect(calls).toEqual(["challenge", "verify"]);
    const cancellation = controller.cancel();
    const nextSignature = deferred<`0x${string}`>();
    const nextSignIn = controller.signIn(() => nextSignature.promise);
    verification.resolve({ session: session() });
    await oldSignIn;
    await cancellation;
    await tick();
    expect(calls).toEqual(["challenge", "verify", "logout", "challenge"]);
    expect(controller.getSnapshot().session).toBeNull();
    await controller.cancel();
    nextSignature.resolve("0xab");
    await nextSignIn;
  });
  it("keeps failed late-verification revocation as a barrier before the next cookie write", async () => {
    const verification = deferred<unknown>();
    let failing = true;
    const { controller, calls } = setup({
      verify: () => verification.promise,
      logout: async () => {
        if (failing) throw new ClientSessionError(503, "Unavailable");
        return {};
      },
    });
    const signIn = controller.signIn(async () => "0xab");
    await tick();
    const cancellation = controller.cancel().catch(() => undefined);
    verification.resolve({ session: session() });
    await signIn;
    await cancellation;
    const before = calls.filter((x) => x === "challenge").length;
    await controller.signIn(async () => "0xab");
    expect(calls.filter((x) => x === "challenge")).toHaveLength(before);
    failing = false;
    await controller.signOut();
    expect(controller.getSnapshot().session).toBeNull();
  });
  it("preserves saved session through reconnect/disconnect and still allows durable sign-out", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const revision = controller.getSnapshot().revision;
    controller.setWallet({ address, chainId, status: "reconnecting" });
    controller.setWallet({ status: "disconnected" });
    expect(controller.getSnapshot().session?.address).toBe(address);
    expect(controller.getSnapshot().revision).toBe(revision);
    expect(calls).not.toContain("logout");
    await controller.signOut();
    expect(calls).toContain("logout");
  });
  it("retires a confirmed new wallet and rejects a different trading seller", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const revision = controller.getSnapshot().revision;
    await expect(
      controller.assertTradingSession(other, chainId),
    ).rejects.toThrow("Connect");
    controller.setWallet({ address: other, chainId, status: "connected" });
    expect(controller.getSnapshot().revision).toBe(revision + 1);
    expect(controller.getSnapshot().session).toBeNull();
    await tick();
    expect(calls).toContain("logout");
  });
  it("never lets a late restore resurrect a signed-out session", async () => {
    const pending = deferred<unknown>();
    const { controller, calls } = setup({ session: () => pending.promise });
    const restore = controller.restore();
    await tick();
    const logout = controller.signOut();
    pending.resolve({ session: session() });
    await restore;
    await logout;
    expect(controller.getSnapshot().session).toBeNull();
    expect(calls).toEqual(["session", "logout"]);
  });
  it("revokes a late refresh before allowing new sign-in cookies", async () => {
    const pending = deferred<unknown>();
    const { controller, calls } = setup({
      session: async () => {
        throw new ClientSessionError(401, "Expired");
      },
      refresh: () => pending.promise,
    });
    const restore = controller.restore();
    await tick();
    expect(calls).toEqual(["session", "refresh"]);
    const logout = controller.signOut();
    pending.resolve({ session: session() });
    await restore;
    await logout;
    expect(calls).toEqual(["session", "refresh", "logout"]);
    expect(controller.getSnapshot().session).toBeNull();
  });
  it("a confirmed wallet change cancels an open prompt without leaving controls busy", async () => {
    const pending = deferred<`0x${string}`>();
    const { controller, calls } = setup();
    const signing = controller.signIn(() => pending.promise);
    await tick();
    controller.setWallet({ status: "disconnected" });
    controller.setWallet({ address: other, chainId, status: "connected" });
    pending.resolve("0xab");
    await signing;
    await tick();
    expect(calls).not.toContain("verify");
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().session).toBeNull();
  });
  it("rechecks a cross-tab logout and clears stale local authentication", async () => {
    let revoked = false;
    const { controller, calls } = setup({
      session: async () => {
        if (revoked) throw new ClientSessionError(401, "Revoked");
        return { session: session() };
      },
      refresh: async () => {
        throw new ClientSessionError(401, "Revoked");
      },
    });
    await controller.restore();
    const revision = controller.getSnapshot().revision;
    revoked = true;
    await controller.recheck();
    expect(controller.getSnapshot().session).toBeNull();
    expect(controller.getSnapshot().revision).toBe(revision + 1);
    expect(calls).not.toContain("logout");
  });
  it("both background rechecks and an old tab's trade reject a different current wallet without revocation", async () => {
    let current = session();
    const { controller, calls } = setup({
      session: async () => ({ session: current }),
    });
    await controller.restore();
    current = { ...session(), id: "new-tab-session", address: other };
    await controller.recheck();
    expect(controller.getSnapshot().session).toBeNull();
    await expect(
      controller.assertTradingSession(address, chainId),
    ).rejects.toThrow("Sign in");
    expect(calls).not.toContain("logout");
  });
  it("a known verification rejection does not revoke another tab's current cookies", async () => {
    const { controller, calls } = setup({
      verify: async () => {
        throw new ClientSessionError(401, "Challenge replaced by another tab");
      },
    });
    await controller.signIn(async () => "0xab");
    expect(calls).toEqual(["challenge", "verify"]);
    expect(controller.getSnapshot().signOutPending).toBe(false);
  });
  it("an uncertain verification response retains compensating revocation", async () => {
    const { controller, calls } = setup({
      verify: async () => {
        throw new ClientSessionError(
          503,
          "Connection lost after cookies",
          true,
        );
      },
    });
    await controller.signIn(async () => "0xab");
    expect(calls).toEqual(["challenge", "verify", "logout"]);
    expect(controller.getSnapshot().session).toBeNull();
  });
  it("a late background result cannot revoke a newer sign-in", async () => {
    const pending = deferred<unknown>();
    const { controller, calls } = setup({ session: () => pending.promise });
    const recheck = controller.recheck();
    await tick();
    const signing = controller.signIn(async () => "0xab");
    pending.resolve({ session: { ...session(), id: "old-read" } });
    await recheck;
    await signing;
    expect(controller.getSnapshot().session?.id).toBe("session-one");
    expect(calls).toEqual(["session", "challenge", "verify"]);
  });
  it("absolute expiry invalidates only the matching local session and never sends logout", async () => {
    const { controller, calls } = setup();
    await controller.restore();
    const saved = controller.getSnapshot().session!;
    const revision = controller.getSnapshot().revision;
    vi.spyOn(Date, "now").mockReturnValue(saved.expiresAt);
    controller.expireSession("old-session-id", saved.expiresAt);
    expect(controller.getSnapshot().session?.id).toBe(saved.id);
    controller.expireSession(saved.id, saved.expiresAt);
    expect(controller.getSnapshot()).toMatchObject({
      session: null,
      authenticated: false,
      revision: revision + 1,
    });
    expect(calls).toEqual(["session"]);
  });
  it("uses token-free cross-tab notifications and cleans up its listener", async () => {
    const channels: Channel[] = [];
    class Channel {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      postMessage = vi.fn();
      close = vi.fn();
      constructor(public name: string) {
        channels.push(this);
      }
    }
    vi.stubGlobal("window", {});
    vi.stubGlobal("BroadcastChannel", Channel);
    const listener = vi.fn();
    const unsubscribe = subscribeToUserSessionChanges(listener);
    const { controller } = setup();
    await controller.signIn(async () => "0xab");
    expect(channels[1].name).toBe(channels[0].name);
    expect(channels[1].postMessage).toHaveBeenCalledWith({
      type: "session-changed",
    });
    expect(channels[1].close).toHaveBeenCalledOnce();
    channels[0].onmessage?.(
      new MessageEvent("message", { data: { type: "other" } }),
    );
    expect(listener).not.toHaveBeenCalled();
    channels[0].onmessage?.(
      new MessageEvent("message", { data: { type: "session-changed" } }),
    );
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(channels[0].close).toHaveBeenCalledOnce();
  });
  it("serializes writers using Web Locks when available", async () => {
    const request = vi.fn(async (_name, callback) => callback());
    vi.stubGlobal("navigator", { locks: { request } });
    const order: string[] = [];
    const pending = deferred<void>();
    const first = serializeUserCookieMutation(async () => {
      order.push("first");
      await pending.promise;
      order.push("first-done");
    });
    const second = serializeUserCookieMutation(async () => {
      order.push("second");
    });
    await tick();
    expect(order).toEqual(["first"]);
    pending.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first-done", "second"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
