import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NftOperationHistory, NftOrderView } from "@/lib/nft/model";
import { NftOrderFacts } from "./nft-order-facts";
import { NftHistoryResults } from "./nft-history-results";

const source: NftOrderView = {
  hash: ("0x" + "ab".repeat(32)) as `0x${string}`,
  side: "listing",
  maker: "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12",
  quantity: "9007199254740993123456789",
  priceWei: "900719925474099312345678901234567890",
  currency: "ETH",
  expiresAt: 1792497600,
  status: "observed",
  sourceURL:
    "https://opensea.io/assets/ethereum/0x1234567890abcdef1234567890abcdef12345678/1",
};
const render = (order: NftOrderView = source) =>
  renderToStaticMarkup(createElement(NftOrderFacts, { order }));
function protectedValue(html: string, value: string) {
  expect(html).toContain(`<span data-no-translate="true">${value}</span>`);
}
describe("native NFT order facts", () => {
  it.each([
    ["quantity", source.quantity],
    ["maker", source.maker],
    ["order hash", source.hash],
    ["currency", source.currency],
    ["status", source.status],
    ["source reference", source.sourceURL!],
  ])("excludes exact %s from page translation", (_label, value) => {
    protectedValue(render(), value);
  });
  it("preserves fractional wei beyond the JavaScript integer range", () => {
    protectedValue(render(), "900719925474099312.34567890123456789");
  });
  it("retains a machine-readable exact expiry beside the localized display", () => {
    expect(render()).toContain(
      '<time dateTime="2026-10-20T12:00:00.000Z" data-no-translate="true">',
    );
  });
  it.each(["listing", "offer"] as const)(
    "keeps the %s interface label outside factual exclusion",
    (side) => {
      const html = render({
        ...source,
        side,
        currency: side === "offer" ? "WETH" : "ETH",
      });
      expect(html).toContain(`<h4>${side === "listing" ? "Listing" : "Offer"}`);
      expect(html).not.toMatch(/<h4[^>]*data-no-translate/);
    },
  );
  it("shows an attributed source as inert text without adding a venue action", () => {
    const html = render();
    expect(html).toContain("Attributed source (reference only):");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<iframe");
  });
  it("does not invent a missing order-specific source reference", () => {
    const { sourceURL: _url, ...withoutSource } = source;
    expect(render(withoutSource)).not.toContain("Attributed source");
  });
  it("escapes source text inside the excluded factual nodes", () => {
    const html = render({ ...source, status: '<img src=x onerror="bad()">' });
    expect(html).toContain('<span data-no-translate="true">&lt;img');
    expect(html).not.toContain("<img");
  });
  it("does not mutate a frozen source order", () => {
    const original = Object.freeze({ ...source });
    const before = JSON.stringify(original);
    render(original);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("private NFT history factual collection boundary", () => {
  it("keeps the private collection slug outside page translation", () => {
    const history: NftOperationHistory = {
      wallet: source.maker,
      chainId: 1,
      page: 1,
      pageSize: 25,
      hasMore: false,
      data: [
        {
          id: "operation_private_0001",
          chainId: 1,
          status: "accepted",
          action: "list",
          collection: "private-observed-collection",
          tokenId: "9007199254740993123456789",
          kind: "signature",
          walletStarted: true,
          orderHash: source.hash,
          updatedAt: "2026-10-20T12:00:00Z",
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(NftHistoryResults, {
        history,
        busy: false,
        onRecover: () => {},
        onPage: () => {},
      }),
    );
    protectedValue(html, "private-observed-collection");
    protectedValue(html, history.data[0].tokenId);
    expect(html).toContain(
      "The venue accepted an order. This does not establish settlement",
    );
    expect(html).toContain("Recover this NFT operation");
  });
});
