import { describe, expect, it } from "vitest";
import { portfolioSessionKey } from "./portfolio-session";
import type {
  UserSessionState,
  SessionWallet,
} from "./user-session-client-state";

const address = "0x1000000000000000000000000000000000000001";
const wallet: SessionWallet = { address, chainId: 560048, status: "connected" };
const auth: Pick<
  UserSessionState,
  "authenticated" | "session" | "signOutPending"
> = {
  authenticated: true,
  signOutPending: false,
  session: {
    id: "session-a",
    address,
    chainId: 560048,
    expiresAt: Date.now() + 60000,
    accessExpiresAt: Date.now() + 60000,
  },
};

describe("portfolio authentication boundary", () => {
  it("requires a session rather than wallet connection alone", () => {
    expect(
      portfolioSessionKey(
        { ...auth, authenticated: false, session: null },
        wallet,
      ),
    ).toBeUndefined();
  });
  it("isolates balances and records by session, address and chain", () => {
    expect(portfolioSessionKey(auth, wallet)).toBe(
      `session-a:${address}:560048`,
    );
    expect(
      portfolioSessionKey(
        { ...auth, session: { ...auth.session!, id: "session-b" } },
        wallet,
      ),
    ).not.toBe(portfolioSessionKey(auth, wallet));
  });
  it.each([
    { ...auth, authenticated: false },
    { ...auth, signOutPending: true },
    { ...auth, session: null },
    { ...auth, session: { ...auth.session!, expiresAt: Date.now() - 1 } },
  ])("hides data when authorization is invalidated", (state) => {
    expect(portfolioSessionKey(state, wallet)).toBeUndefined();
  });
  it.each([
    { ...wallet, address: "0x2000000000000000000000000000000000000002" },
    { ...wallet, chainId: 1 },
    { ...wallet, status: "disconnected" as const },
    { ...wallet, status: "reconnecting" as const },
  ])("rejects a changed wallet before any provider effect", (current) => {
    expect(portfolioSessionKey(auth, current)).toBeUndefined();
  });
});
