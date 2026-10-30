import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RWAPublicationForm } from "./rwa-publication";
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
    address: string;
    chainId: number;
    expiresAt: number;
    accessExpiresAt: number;
  },
}));
vi.mock("wagmi", () => ({ useAccount: () => state.wallet }));
vi.mock("./user-session-provider", () => ({ useUserSession: () => state }));
describe("source publication UI boundaries", () => {
  beforeEach(() => {
    state.authenticated = true;
    state.signOutPending = false;
    state.wallet = {
      address: "0x" + "1".repeat(40),
      chainId: 560048,
      status: "connected",
    };
    state.session = {
      id: "ordinary-session",
      address: state.wallet.address,
      chainId: 560048,
      expiresAt: 4e12,
      accessExpiresAt: 4e12,
    };
  });
  it("offers public source-proof publication to an ordinary session without administrator role", () => {
    const html = renderToStaticMarkup(createElement(RWAPublicationForm));
    expect(html).toContain("Prepare public source-review draft");
    expect(html).toContain("Verify source and publish public record");
    expect(html).toContain('data-no-translate="true"');
    expect(html).toContain('data-translation-skip="true"');
    expect(html).toContain("Do not enter a source private key");
  });
  it.each([
    "connection-only",
    "wallet-change",
    "chain-change",
    "logout",
    "expiry",
  ])("hides the public write form during %s", (change) => {
    if (change === "connection-only") state.authenticated = false;
    if (change === "wallet-change")
      state.wallet.address = "0x" + "2".repeat(40);
    if (change === "chain-change") state.wallet.chainId = 1;
    if (change === "logout") state.signOutPending = true;
    if (change === "expiry") state.session!.expiresAt = 1;
    const html = renderToStaticMarkup(createElement(RWAPublicationForm));
    expect(html).not.toContain("Signed source evidence (JSON)");
    expect(html).toContain("Sign in to publish source-verified assets");
  });
});
