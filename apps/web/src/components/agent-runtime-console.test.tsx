import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  wallet: {
    address: "0x" + "a".repeat(40),
    chainId: 560048,
    status: "connected",
  },
  authenticated: true,
  signOutPending: false,
  session: {
    id: "test-session",
    address: "0x" + "a".repeat(40),
    chainId: 560048,
    expiresAt: 4000000000000,
    accessExpiresAt: 4000000000000,
  },
}));
vi.mock("wagmi", () => ({ useAccount: () => state.wallet }));
vi.mock("@/components/user-session-provider", () => ({
  useUserSession: () => state,
}));
import { AgentRuntimeConsole } from "./agent-runtime-console";
describe("agent private console boundary", () => {
  beforeEach(() => {
    state.wallet = {
      address: "0x" + "a".repeat(40),
      chainId: 560048,
      status: "connected",
    };
    state.authenticated = true;
    state.signOutPending = false;
    state.session = {
      id: "test-session",
      address: "0x" + "a".repeat(40),
      chainId: 560048,
      expiresAt: 4000000000000,
      accessExpiresAt: 4000000000000,
    };
  });
  it("marks authenticated operation data as private from translation and discloses test-only status", () => {
    const html = renderToStaticMarkup(createElement(AgentRuntimeConsole));
    expect(html).toContain('data-no-translate="true"');
    expect(html).toContain('data-translation-skip="true"');
    expect(html).toContain("TEST_ONLY");
    expect(html).toContain(
      "Autonomous signing, broadcasting and nonce revocation are unavailable",
    );
  });
  it.each(["account", "chain", "logout", "expired", "disconnected"])(
    "hides records immediately for %s",
    (kind) => {
      if (kind === "account") state.wallet.address = "0x" + "b".repeat(40);
      if (kind === "chain") state.wallet.chainId = 1;
      if (kind === "logout") state.signOutPending = true;
      if (kind === "expired") state.session.expiresAt = 1;
      if (kind === "disconnected") state.wallet.status = "disconnected";
      const html = renderToStaticMarkup(createElement(AgentRuntimeConsole));
      expect(html).toContain("Sign in with your wallet");
      expect(html).not.toContain("Read an operation");
    },
  );
});
