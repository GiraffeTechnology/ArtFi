import { describe, expect, it } from "vitest";
import {
  mergeNftCatalogPage,
  observeNftCatalogPage,
  type NftCatalogPage,
} from "./catalog";
import type { NftScope } from "./model";
const scope: NftScope = {
  slug: "test-only",
  chain: "ethereum",
  contract: "0x1111111111111111111111111111111111111111",
  standard: "erc1155",
  label: "TEST ONLY",
  charity: true,
};
function page(time = "2026-10-10T01:00:00Z", tokenId = "1"): NftCatalogPage {
  return {
    source: "opensea",
    observedAt: time,
    scope,
    next: null,
    data: [
      {
        tokenId,
        name: "TEST ONLY",
        contract: scope.contract,
        standard: scope.standard,
        collection: scope.slug,
        sourceURL: "https://opensea.io/assets/ethereum/test-only/1",
      },
    ],
  };
}
describe("NFT catalog observation provenance", () => {
  it("retains the server observation and attributed source without substituting browser time", () => {
    const result = observeNftCatalogPage(page(), scope);
    expect(result[0]).toMatchObject({
      source: "opensea",
      observedAt: "2026-10-10T01:00:00Z",
      sourceURL: page().data[0].sourceURL,
    });
  });
  it("keeps distinct pagination times and does not refresh duplicate records", () => {
    const first = observeNftCatalogPage(page(), scope);
    const later = observeNftCatalogPage(
      {
        ...page("2026-10-10T02:00:00Z", "2"),
        data: [...page().data, ...page(undefined, "2").data],
      },
      scope,
    );
    const result = mergeNftCatalogPage(first, later, true);
    expect(
      result.map(({ tokenId, observedAt }) => ({ tokenId, observedAt })),
    ).toEqual([
      { tokenId: "1", observedAt: "2026-10-10T01:00:00Z" },
      { tokenId: "2", observedAt: "2026-10-10T02:00:00Z" },
    ]);
  });
  it("replaces prior observations only on a successful fresh first page", () => {
    const result = mergeNftCatalogPage(
      observeNftCatalogPage(page(), scope),
      observeNftCatalogPage(page("2026-10-10T03:00:00Z", "3"), scope),
      false,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tokenId: "3",
      observedAt: "2026-10-10T03:00:00Z",
    });
  });
  it.each(["", "not-a-time"])(
    "does not fabricate an observation for invalid time %s",
    (observedAt) => {
      expect(() => observeNftCatalogPage(page(observedAt), scope)).toThrow(
        /observation time/,
      );
    },
  );
  it("refuses mismatched source or collection provenance", () => {
    expect(() =>
      observeNftCatalogPage(
        { ...page(), source: "unknown" as "opensea" },
        scope,
      ),
    ).toThrow();
    expect(() =>
      observeNftCatalogPage(
        { ...page(), scope: { ...scope, chain: "base" } },
        scope,
      ),
    ).toThrow();
    expect(() =>
      observeNftCatalogPage(
        { ...page(), scope: { ...scope, slug: "another" } },
        scope,
      ),
    ).toThrow();
  });
});
