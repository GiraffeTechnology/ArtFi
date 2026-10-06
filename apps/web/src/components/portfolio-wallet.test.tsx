import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioWallet } from "./portfolio-wallet";
import { PortfolioRecords } from "./portfolio-records";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  auth: vi.fn(),
  balance: vi.fn(),
}));
vi.mock("wagmi", () => ({
  useAccount: mocks.account,
  useBalance: mocks.balance,
}));
vi.mock("./user-session-provider", () => ({ useUserSession: mocks.auth }));
vi.mock("./wallet-button", () => ({ WalletButton: () => null }));
const address = "0x1000000000000000000000000000000000000001";
const session = {
  id: "session-a",
  address,
  chainId: 560048,
  expiresAt: Date.now() + 60000,
};

describe("portfolio rendering and balance cache", () => {
  beforeEach(() => {
    mocks.account.mockReturnValue({
      address,
      chainId: 560048,
      status: "connected",
      isConnected: true,
    });
    mocks.auth.mockReturnValue({
      session,
      authenticated: true,
      signOutPending: false,
    });
    mocks.balance
      .mockReset()
      .mockReturnValue({ data: { formatted: "123.4567" } });
  });
  it("does not mount a balance read for a connected unsigned-in wallet", () => {
    mocks.auth.mockReturnValue({
      session: null,
      authenticated: false,
      signOutPending: false,
    });
    expect(renderToStaticMarkup(createElement(PortfolioWallet))).toContain(
      "Sign in to view wallet assets",
    );
    expect(renderToStaticMarkup(createElement(PortfolioRecords))).toContain(
      "Sign in with the connected wallet",
    );
    expect(mocks.balance).not.toHaveBeenCalled();
  });
  it("scopes the query to this session and discards cache on unmount", () => {
    expect(renderToStaticMarkup(createElement(PortfolioWallet))).toContain(
      "123.4567",
    );
    expect(mocks.balance).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: `session-a:${address}:560048`,
        query: { enabled: true, gcTime: 0 },
      }),
    );
  });
  it.each(["logout", "expiry", "account-change", "chain-change"])(
    "cannot reveal cached balance after %s",
    (change) => {
      renderToStaticMarkup(createElement(PortfolioWallet));
      mocks.balance.mockClear();
      if (change === "logout")
        mocks.auth.mockReturnValue({ session: null, authenticated: false });
      if (change === "expiry")
        mocks.auth.mockReturnValue({
          session: { ...session, expiresAt: 1 },
          authenticated: true,
        });
      if (change === "account-change")
        mocks.account.mockReturnValue({
          address: "0x2000000000000000000000000000000000000002",
          chainId: 560048,
          status: "connected",
          isConnected: true,
        });
      if (change === "chain-change")
        mocks.account.mockReturnValue({
          address,
          chainId: 1,
          status: "connected",
          isConnected: true,
        });
      const html = renderToStaticMarkup(createElement(PortfolioWallet));
      expect(html).not.toContain("123.4567");
      expect(html).toContain("Sign in to view wallet assets");
      expect(mocks.balance).not.toHaveBeenCalled();
      expect(renderToStaticMarkup(createElement(PortfolioRecords))).toContain(
        "Sign in with the connected wallet",
      );
    },
  );
});
