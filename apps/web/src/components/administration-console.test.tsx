import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdministrationConsole } from "./administration-console";
import { ModerationSupport } from "./moderation-support";
import { ModerationCaseDetail } from "./moderation-shared";
import type { ModerationCase } from "@/lib/administration";
const state = vi.hoisted(() => ({
  wallet: {
    address: "0x" + "1".repeat(40),
    chainId: 560048,
    status: "connected",
  },
  signOutPending: false,
  authenticated: false,
  session: null as null | {
    id: string;
    address: string;
    chainId: number;
    expiresAt: number;
    accessExpiresAt: number;
  },
}));
vi.mock("wagmi", () => ({ useAccount: () => state.wallet }));
vi.mock("@/components/user-session-provider", () => ({
  useUserSession: () => state,
}));
describe("administration UI permission and disclosure boundaries", () => {
  beforeEach(() => {
    state.wallet = {
      address: "0x" + "1".repeat(40),
      chainId: 560048,
      status: "connected",
    };
    state.signOutPending = false;
    state.authenticated = false;
    state.session = null;
  });
  it("requires an authenticated wallet before showing the private workspace", () => {
    state.session = {
      id: "session",
      address: "0x" + "1".repeat(40),
      chainId: 560048,
      expiresAt: 4000000000000,
      accessExpiresAt: 4000000000000,
    };
    const html = renderToStaticMarkup(createElement(AdministrationConsole));
    expect(html).toContain("Administrator sign-in");
    expect(html).not.toContain("Content review queue");
    const support = renderToStaticMarkup(createElement(ModerationSupport));
    expect(support).not.toContain("Submit private report");
    expect(support).toContain("Public content notices");
  });
  it("isolates private workspaces from translation-service transmission", () => {
    state.authenticated = true;
    state.session = {
      id: "session",
      address: "0x" + "1".repeat(40),
      chainId: 560048,
      expiresAt: 4000000000000,
      accessExpiresAt: 4000000000000,
    };
    const admin = renderToStaticMarkup(createElement(AdministrationConsole));
    const support = renderToStaticMarkup(createElement(ModerationSupport));
    expect(admin).toContain('data-no-translate="true"');
    expect(admin).toContain('data-translation-skip="true"');
    expect(support).toContain('data-no-translate="true"');
    expect(support).toContain('data-translation-skip="true"');
  });
  it.each(["account", "chain", "pending-logout", "expired"])(
    "hides private work before effects on %s",
    (kind) => {
      state.authenticated = true;
      state.session = {
        id: "session",
        address: "0x" + "1".repeat(40),
        chainId: 560048,
        expiresAt: 4000000000000,
        accessExpiresAt: 4000000000000,
      };
      if (kind === "account") state.wallet.address = "0x" + "2".repeat(40);
      if (kind === "chain") state.wallet.chainId = 1;
      if (kind === "pending-logout") state.signOutPending = true;
      if (kind === "expired") state.session.expiresAt = 1;
      expect(
        renderToStaticMarkup(createElement(AdministrationConsole)),
      ).toContain("Administrator sign-in");
      expect(
        renderToStaticMarkup(createElement(ModerationSupport)),
      ).not.toContain("Submit private report");
    },
  );
  it("renders report content and appeals as escaped text, never executable markup", () => {
    const record = {
      id: "a".repeat(32),
      target: '<script>alert("reference")</script>',
      details: '<img src=x onerror="alert(1)">',
      category: "other",
      status: "resolved",
      decision: "no_action",
      decisionReason: "Reviewed explanation",
      publicNotice: "",
      revision: 3,
      appealStatus: "rejected",
      appealStatement: "Private appeal evidence",
      appealResponse: "Reasoned response",
      createdAt: "2026-10-05T00:00:00Z",
      updatedAt: "2026-10-05T00:00:00Z",
    } as ModerationCase;
    const html = renderToStaticMarkup(
      createElement(ModerationCaseDetail, { record }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Private appeal evidence");
    expect(html).toContain("Reasoned response");
  });
});
