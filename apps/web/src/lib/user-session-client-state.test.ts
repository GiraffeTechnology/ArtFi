import { describe, expect, it } from "vitest";
import {
  authenticatedSession,
  sameWallet,
  type UserSession,
} from "./user-session-client-state";
const address = "0x1234567890123456789012345678901234567890";
const session: UserSession = {
  id: "session-one",
  address,
  chainId: 560048,
  expiresAt: Date.now() + 60_000,
  accessExpiresAt: Date.now() + 30_000,
};
describe("user wallet binding", () => {
  it("requires matching chain and wallet and treats reconnecting separately", () => {
    expect(sameWallet(session, address, 560048)).toBe(true);
    expect(sameWallet(session, address, 1)).toBe(false);
    expect(
      authenticatedSession(session, {
        address,
        chainId: 560048,
        status: "connected",
      }),
    ).toBe(true);
    expect(
      authenticatedSession(session, {
        address,
        chainId: 560048,
        status: "reconnecting",
      }),
    ).toBe(false);
    expect(authenticatedSession(session, { status: "disconnected" })).toBe(
      false,
    );
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import { UserSessionControls } from "../components/user-session-controls";
import {
  ClientSessionController,
  ClientSessionError,
  type SessionAPI,
} from "./user-session-client";

const renderedAuth = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
vi.mock("@/components/user-session-provider", () => ({
  useUserSession: () => renderedAuth.current,
}));

describe("disconnected sign-out controls", () => {
  it("renders an enabled retry after failed revocation, then removes it only after success", async () => {
    let available = false;
    const actions: string[] = [];
    const api: SessionAPI = async (action) => {
      actions.push(action);
      if (action === "logout") {
        if (!available) throw new ClientSessionError(503, "Unavailable");
        return { session: null };
      }
      return { session };
    };
    const controller = new ClientSessionController(api);
    controller.setWallet({ address, chainId: 560048, status: "connected" });
    await controller.restore();
    controller.setWallet({ status: "disconnected" });
    await expect(controller.signOut()).rejects.toThrow("Unavailable");
    expect(controller.getSnapshot()).toMatchObject({
      session: null,
      signOutPending: true,
      busy: false,
      walletStatus: "disconnected",
    });
    renderedAuth.current = {
      ...controller.getSnapshot(),
      signOut: controller.signOut,
    };
    const failedHTML = renderToStaticMarkup(createElement(UserSessionControls));
    expect(failedHTML).toContain("Retry sign out");
    expect(failedHTML).not.toMatch(/<button[^>]*disabled/);
    expect(failedHTML).not.toContain(">Sign in<");
    await controller.recheck();
    expect(actions).toEqual(["session", "logout"]);
    available = true;
    await controller.signOut();
    expect(controller.getSnapshot().signOutPending).toBe(false);
    renderedAuth.current = {
      ...controller.getSnapshot(),
      signOut: controller.signOut,
    };
    const completedHTML = renderToStaticMarkup(
      createElement(UserSessionControls),
    );
    expect(completedHTML).not.toContain("Retry sign out");
    expect(completedHTML).toContain("Sign in");
    expect(actions).toEqual(["session", "logout", "logout"]);
  });
});
