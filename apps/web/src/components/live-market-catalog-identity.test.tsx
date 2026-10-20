import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readMarketAsset,
  type MarketAsset,
} from "@/lib/complete-market-catalog";

const seeded = vi.hoisted(() => ({ assets: [] as readonly MarketAsset[] }));
// Seed only the catalog's initial empty array. Effects and HTTP are not run by SSR.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        Array.isArray(initial) && initial.length === 0
          ? seeded.assets
          : initial,
      ),
  };
});
vi.mock("next/font/local", () => ({
  default: () => ({ className: "test-font" }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
import { LiveMarketCatalog } from "./live-market-catalog";

const contract = "0x1234567890abcdef1234567890abcdef12345678";
const maximumToken = ((1n << 256n) - 1n).toString();
function asset(overrides: Partial<MarketAsset> = {}) {
  return readMarketAsset({
    source: "opensea",
    chain: "ethereum",
    contractAddress: contract,
    tokenId: maximumToken,
    collectionSlug: "Observed collection",
    latestEventType: "item_listed",
    latestEventTimestamp: "2026-10-20T12:00:00.000Z",
    orderStatus: "active",
    orderHash: "0x" + "1".repeat(64),
    ...overrides,
  });
}
function render(...assets: MarketAsset[]) {
  seeded.assets = assets;
  return renderToStaticMarkup(createElement(LiveMarketCatalog));
}
function cards(html: string) {
  return html.match(/<article\b[\s\S]*?<\/article>/g) ?? [];
}

describe("live market asset identity static rendering", () => {
  beforeEach(() => {
    seeded.assets = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:20.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each(["ethereum", "hoodi", "base"])(
    "shows the actual %s chain without a deployment-chain substitution",
    (chain) => {
      const [card] = cards(render(asset({ chain })));
      expect(card).toMatch(
        new RegExp(`<dt>Chain</dt><dd data-no-translate="true">${chain}</dd>`),
      );
      expect(card).toContain(`Chain: ${chain}`);
    },
  );
  it("makes the complete contract and uint256 token identity available", () => {
    const [card] = cards(render(asset()));
    expect(card).toContain("<summary>Full asset identity</summary>");
    expect(card).toContain(`Contract: ${contract}`);
    expect(card).toContain(`Token ID: ${maximumToken}`);
    expect(card).toContain("overflow-wrap:anywhere");
  });
  it("distinguishes identical contract/token pairs on different chains", () => {
    const result = cards(
      render(asset({ chain: "ethereum" }), asset({ chain: "hoodi" })),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Chain: ethereum");
    expect(result[0]).not.toContain("Chain: hoodi");
    expect(result[1]).toContain("Chain: hoodi");
    for (const card of result) {
      expect(card).toContain(`Contract: ${contract}`);
      expect(card).toContain(`Token ID: ${maximumToken}`);
    }
  });
  it("preserves the exact source contract spelling and decimal token text", () => {
    const mixed = "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12";
    const [card] = cards(
      render(asset({ contractAddress: mixed, tokenId: "0" })),
    );
    expect(card).toContain(`Contract: ${mixed}`);
    expect(card).toContain("Token ID: 0");
  });
  it("escapes source collection text as text", () => {
    const [card] = cards(
      render(asset({ collectionSlug: '<img src=x onerror="bad()">' })),
    );
    expect(card).toContain("&lt;img");
    expect(card).not.toContain("<img");
  });
  it("keeps a valid attributed source URL inert and retains native navigation", () => {
    const url = "https://opensea.io/assets/ethereum/" + contract + "/1";
    const [card] = cards(render(asset({ marketplaceUrl: url })));
    expect(card).toContain("<summary>Source reference</summary>");
    expect(card).toContain(url);
    expect(card).not.toContain(`href="${url}"`);
    expect(card).toContain('href="/nft"');
  });
  it.each([
    "javascript:alert(1)",
    "https://opensea.io.attacker.invalid/assets/1",
    "https://user:password@opensea.io/assets/1",
    "http://opensea.io/assets/1",
  ])("does not expose an unsafe venue reference: %s", (marketplaceUrl) => {
    const [card] = cards(render(asset({ marketplaceUrl })));
    expect(card).not.toContain("<summary>Source reference</summary>");
    expect(card).toContain("No venue link was attributed");
  });
  it("retains source attribution, freshness and observed-only trading boundaries", () => {
    const [card] = cards(render(asset()));
    expect(card).toContain("<dt>Source</dt><dd>OpenSea</dd>");
    expect(card).toContain("<dt>Freshness</dt>");
    expect(card).toContain("No public preview");
    expect(card).toContain("This panel does not submit an order");
    expect(card).toContain("Open native NFT trading");
    expect(card).not.toContain("<button");
  });
});
