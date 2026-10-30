import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  wallet: {
    address: "0x" + "1".repeat(40),
    chainId: 560048,
    status: "connected",
  },
  authenticated: false,
  signOutPending: false,
  session: null as null | {
    id: string;
    address: `0x${string}`;
    chainId: number;
    expiresAt: number;
    accessExpiresAt: number;
  },
}));
vi.mock("wagmi", () => ({ useAccount: () => state.wallet }));
vi.mock("./user-session-provider", () => ({ useUserSession: () => state }));
import { NotificationInbox } from "./notification-inbox";
describe("notification private workspace render boundary", () => {
  beforeEach(() => {
    state.wallet = {
      address: "0x" + "1".repeat(40),
      chainId: 560048,
      status: "connected",
    };
    state.authenticated = true;
    state.signOutPending = false;
    state.session = {
      id: "a".repeat(32),
      address: ("0x" + "1".repeat(40)) as `0x${string}`,
      chainId: 560048,
      expiresAt: 4000000000000,
      accessExpiresAt: 4000000000000,
    };
  });
  it.each([
    "anonymous",
    "account",
    "chain",
    "disconnect",
    "logout",
    "expiry",
    "access-expiry",
  ])("hides the private inbox before effects on %s", (change) => {
    if (change === "anonymous") state.authenticated = false;
    if (change === "account") state.wallet.address = "0x" + "2".repeat(40);
    if (change === "chain") state.wallet.chainId = 1;
    if (change === "disconnect") state.wallet.status = "disconnected";
    if (change === "logout") state.signOutPending = true;
    if (change === "expiry") state.session!.expiresAt = 1;
    if (change === "access-expiry") state.session!.accessExpiresAt = 1;
    const html = renderToStaticMarkup(createElement(NotificationInbox));
    expect(html).toContain("Connecting an address alone does not sign you in.");
    expect(html).not.toContain(state.session!.address);
    expect(html).not.toContain("Save preferences");
  });
});
