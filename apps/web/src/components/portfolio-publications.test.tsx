import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortfolioPublications,
  PortfolioPublicationEntries,
} from "./portfolio-publications";
import {
  publicationAsset,
  publicationOrder,
  publicationPage,
  publicationSeller,
} from "@/lib/portfolio-publication.test-fixture";

const mocks = vi.hoisted(() => ({ wallet: vi.fn(), auth: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: mocks.wallet }));
vi.mock("./user-session-provider", () => ({ useUserSession: mocks.auth }));
const session = () => ({
  id: "TEST_ONLY_SESSION",
  address: publicationSeller,
  chainId: 560048,
  expiresAt: Date.now() + 60_000,
  accessExpiresAt: Date.now() + 60_000,
});
beforeEach(() => {
  mocks.wallet.mockReturnValue({
    address: publicationSeller,
    chainId: 560048,
    status: "connected",
  });
  mocks.auth.mockReturnValue({
    session: session(),
    authenticated: true,
    signOutPending: false,
  });
});
describe("publication personal-center rendering", () => {
  it("mounts a read-only loading panel only for the current authenticated Hoodi wallet", () => {
    const html = renderToStaticMarkup(createElement(PortfolioPublications));
    expect(html).toContain('data-testid="portfolio-publications"');
    expect(html).toContain("Reading published sale records");
    expect(html).toContain(
      "Buyer offers and external-venue orders are not included",
    );
    expect(html).not.toContain("Settle");
  });
  it.each([
    "unsigned",
    "logout-pending",
    "session-expired",
    "access-expired",
    "wallet-changed",
    "chain-changed",
  ])(
    "hides every publication before the provider effect catches up: %s",
    (change) => {
      if (change === "unsigned")
        mocks.auth.mockReturnValue({ authenticated: false, session: null });
      if (change === "logout-pending")
        mocks.auth.mockReturnValue({
          authenticated: true,
          session: session(),
          signOutPending: true,
        });
      if (change === "session-expired")
        mocks.auth.mockReturnValue({
          authenticated: true,
          session: { ...session(), expiresAt: 1 },
        });
      if (change === "access-expired")
        mocks.auth.mockReturnValue({
          authenticated: true,
          session: { ...session(), accessExpiresAt: 1 },
        });
      if (change === "wallet-changed")
        mocks.wallet.mockReturnValue({
          address: publicationAsset,
          chainId: 560048,
          status: "connected",
        });
      if (change === "chain-changed")
        mocks.wallet.mockReturnValue({
          address: publicationSeller,
          chainId: 1,
          status: "connected",
        });
      const html = renderToStaticMarkup(createElement(PortfolioPublications));
      expect(html).not.toContain('data-testid="portfolio-publications"');
      expect(html).toContain("Sign in with the connected Hoodi wallet");
    },
  );
  it.each(["whole", "fraction"] as const)(
    "renders exact %s facts without exposing the signature or claiming settlement",
    (kind) => {
      const order = publicationOrder({ kind });
      order.signature = "0xabcdef";
      const html = renderToStaticMarkup(
        createElement(PortfolioPublicationEntries, {
          page: { ...publicationPage(), data: [order] },
        }),
      );
      expect(html).toContain("900719925474099300000001");
      expect(html).toContain(publicationSeller);
      expect(html).toContain(order.intentHash);
      expect(html).toContain("Execution status is not established");
      expect(html).toContain(
        "not a frozen snapshot or a count of active orders",
      );
      expect(html).not.toContain("0xabcdef");
      expect(html).toContain("data-no-translate");
    },
  );
  it("keeps an empty later page distinct from absence of all orders", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioPublicationEntries, {
        page: { ...publicationPage(), page: 2, data: [], total: 0 },
      }),
    );
    expect(html).toContain("No publication was returned on this page");
    expect(html).not.toContain("You have no orders");
  });
});
