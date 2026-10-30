import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RevenueClaims } from "./revenue-claims";
vi.mock("wagmi", () => ({
  useAccount: () => ({ status: "disconnected" }),
  usePublicClient: () => undefined,
  useWriteContract: () => ({}),
}));
vi.mock("./user-session-provider", () => ({
  useUserSession: () => ({ authenticated: false, revision: 0, session: null }),
}));
vi.mock("@/lib/public-runtime-config", () => ({
  publicSetting: () => undefined,
}));
describe("revenue claim availability", () => {
  it("does not substitute sample revenue or a transaction control for a missing configured binding", () => {
    const html = renderToStaticMarkup(<RevenueClaims />);
    expect(html).toContain("not configured");
    expect(html).not.toContain("Confirm claim in wallet");
  });
});
