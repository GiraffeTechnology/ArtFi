import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionWallet,
  UserSessionState,
} from "@/lib/user-session-client-state";

// TEST_ONLY: render a lagging controller snapshot without effects. This models
// the first wallet-change render, not production SSR or real wallet acceptance.
const mock = vi.hoisted(() => ({
  wallet: {} as SessionWallet,
  snapshot: {} as UserSessionState,
  setWallet: vi.fn(),
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  refresh: vi.fn(async () => null),
  restore: vi.fn(async () => null),
  recheck: vi.fn(async () => null),
  signMessage: vi.fn(async () => "0x01"),
}));
vi.mock("wagmi", () => ({
  useAccount: () => mock.wallet,
  useSignMessage: () => ({ signMessageAsync: mock.signMessage }),
}));
vi.mock("@/lib/user-session-client", () => ({
  userSessionController: {
    getSnapshot: () => mock.snapshot,
    // The fixture intentionally supplies a restored snapshot before any effect.
    getServerSnapshot: () => mock.snapshot,
    subscribe: () => () => undefined,
    setWallet: mock.setWallet,
    restore: mock.restore,
    recheck: mock.recheck,
    signIn: mock.signIn,
    signOut: mock.signOut,
    cancel: mock.cancel,
    refresh: mock.refresh,
  },
  subscribeToUserSessionChanges: () => () => undefined,
}));
import { UserSessionProvider, useUserSession } from "./user-session-provider";
import { UserSessionControls } from "./user-session-controls";

const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const now = Date.UTC(2026, 9, 30);
const privateMarker = "PRIVATE_AUTHENTICATED_HOLDING_FROM_WALLET_A";
let observed: ReturnType<typeof useUserSession> | undefined;
function PrivateConsumer() {
  const auth = useUserSession();
  observed = auth;
  return createElement(
    "section",
    { "data-authenticated": String(auth.authenticated) },
    auth.authenticated ? privateMarker : "Sign in to view private holdings",
  );
}
function render() {
  observed = undefined;
  return renderToStaticMarkup(
    createElement(
      UserSessionProvider,
      null,
      createElement(PrivateConsumer),
      createElement(UserSessionControls),
    ),
  );
}
function expectNoEffects() {
  expect(mock.setWallet).not.toHaveBeenCalled();
  expect(mock.restore).not.toHaveBeenCalled();
  expect(mock.recheck).not.toHaveBeenCalled();
  expect(mock.signIn).not.toHaveBeenCalled();
  expect(mock.signMessage).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  mock.wallet = { address, chainId: 560048, status: "connected" };
  mock.snapshot = {
    session: {
      id: "restored-session-a",
      address,
      chainId: 560048,
      expiresAt: now + 60_000,
      accessExpiresAt: now + 30_000,
    },
    authenticated: true,
    walletStatus: "connected",
    revision: 7,
    busy: false,
    signingIn: false,
    signOutPending: false,
    detail: "",
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("live wallet session provider render", () => {
  it("keeps the matching authenticated wallet visible before any effect", () => {
    expect(render()).toContain(privateMarker);
    expect(observed?.authenticated).toBe(true);
    expectNoEffects();
  });
  it.each<[string, SessionWallet]>([
    [
      "different account",
      { address: other, chainId: 560048, status: "connected" },
    ],
    ["different chain", { address, chainId: 1, status: "connected" }],
    ["missing account", { chainId: 560048, status: "connected" }],
    ["missing chain", { address, status: "connected" }],
    ["connecting", { address, chainId: 560048, status: "connecting" }],
    ["reconnecting", { address, chainId: 560048, status: "reconnecting" }],
    ["disconnected", { status: "disconnected" }],
  ])("hides prior authentication on the first %s render", (_name, wallet) => {
    mock.wallet = wallet;
    const original = structuredClone(mock.snapshot);
    expect(render()).not.toContain(privateMarker);
    expect(observed?.authenticated).toBe(false);
    expect(observed?.walletStatus).toBe(wallet.status);
    // Do not mutate or revoke durable/controller state as part of rendering.
    expect(mock.snapshot).toEqual(original);
    expect(observed?.revision).toBe(7);
    expectNoEffects();
    expect(mock.signOut).not.toHaveBeenCalled();
  });
  it("matches the same address regardless of letter casing", () => {
    mock.wallet.address = "0x" + address.slice(2).toUpperCase();
    expect(render()).toContain(privateMarker);
    expectNoEffects();
  });
  it.each(["accessExpiresAt", "expiresAt"] as const)(
    "hides expired %s before a delayed deadline callback",
    (field) => {
      mock.snapshot.session![field] = now;
      expect(render()).not.toContain(privateMarker);
      expect(observed?.authenticated).toBe(false);
      expectNoEffects();
    },
  );
  it("never promotes an unauthenticated controller snapshot", () => {
    mock.snapshot.authenticated = false;
    expect(render()).not.toContain(privateMarker);
    expect(observed?.authenticated).toBe(false);
    expectNoEffects();
  });
  it("does not advertise authentication while retirement is pending", () => {
    mock.snapshot.signOutPending = true;
    expect(render()).not.toContain(privateMarker);
    expect(observed?.signOutPending).toBe(true);
    expectNoEffects();
  });
  it("keeps a saved disconnected session available for explicit sign-out", async () => {
    mock.wallet = { status: "disconnected" };
    const html = render();
    expect(html).not.toContain(privateMarker);
    expect(html).toContain("Wallet session saved");
    expect(html).toContain("Sign out");
    expect(observed?.session).toBe(mock.snapshot.session);
    expect(observed?.signOut).toBe(mock.signOut);
    await observed!.signOut();
    expect(mock.signOut).toHaveBeenCalledTimes(1);
    expectNoEffects();
  });
  it("retains an enabled disconnected retry after failed sign-out", () => {
    mock.wallet = { status: "disconnected" };
    mock.snapshot.session = null;
    mock.snapshot.authenticated = false;
    mock.snapshot.signOutPending = true;
    mock.snapshot.walletStatus = "connected";
    const html = render();
    expect(html).toContain("Retry sign out");
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(observed?.signOutPending).toBe(true);
    expect(observed?.walletStatus).toBe("disconnected");
    expectNoEffects();
  });
  it("exposes the live connected status without authenticating a missing session", () => {
    mock.snapshot.session = null;
    mock.snapshot.authenticated = false;
    mock.snapshot.walletStatus = "disconnected";
    const html = render();
    expect(html).toContain(">Sign in<");
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(observed?.authenticated).toBe(false);
    expect(observed?.walletStatus).toBe("connected");
    expectNoEffects();
  });
  it("keeps an existing busy retirement barrier intact", () => {
    mock.wallet = { address: other, chainId: 560048, status: "connected" };
    mock.snapshot.session = null;
    mock.snapshot.authenticated = false;
    mock.snapshot.signOutPending = true;
    mock.snapshot.busy = true;
    const html = render();
    expect(html).toContain("Retry sign out");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(observed?.busy).toBe(true);
    expect(observed?.signOutPending).toBe(true);
    expectNoEffects();
  });
});
