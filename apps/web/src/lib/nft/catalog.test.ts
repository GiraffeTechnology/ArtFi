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

describe("record-level native catalog binding", () => {
  it.each(["foreign-record", "invalid-calendar", "page-duplicates"])(
    "catalog-binding regression: handles %s without inventing identity or freshness",
    (field) => {
      const value = page();
      if (field === "foreign-record")
        value.data[0]!.contract = "0x2222222222222222222222222222222222222222";
      if (field === "invalid-calendar")
        value.observedAt = "2026-02-31T00:00:00Z";
      if (field === "page-duplicates") {
        value.data.push({ ...value.data[0]!, name: "Later duplicate" });
        expect(observeNftCatalogPage(value, scope)).toHaveLength(1);
        return;
      }
      expect(() => observeNftCatalogPage(value, scope)).toThrow();
    },
  );
  it.each([
    "token",
    "standard",
    "collection",
    "name",
    "sourceURL",
    "private-field",
    "credential-url",
    "oversized-page",
  ])("rejects malformed %s atomically", (field) => {
    const value = page();
    if (field === "token") value.data[0]!.tokenId = "01";
    if (field === "standard") value.data[0]!.standard = "erc721";
    if (field === "collection") value.data[0]!.collection = "other";
    if (field === "name") value.data[0]!.name = "x".repeat(201);
    if (field === "sourceURL")
      value.data[0]!.sourceURL = "https://other.invalid/7";
    if (field === "private-field")
      Reflect.set(value.data[0]!, "accessToken", "TEST_ONLY-never-copy");
    if (field === "credential-url")
      value.data[0]!.sourceURL = "https://user:password@opensea.io/7";
    if (field === "oversized-page")
      value.data = Array.from({ length: 25 }, (_, n) => ({
        ...value.data[0]!,
        tokenId: String(n),
      }));
    expect(() => observeNftCatalogPage(value, scope)).toThrow();
  });
  it.each([
    "cursor",
    "missing-cursor",
    "extra-envelope",
    "changed-charity",
    "array-row",
    "null-page",
  ])("rejects incompatible %s", (field) => {
    const value = page();
    if (field === "cursor") value.next = "bad\ncursor";
    if (field === "missing-cursor") Reflect.deleteProperty(value, "next");
    if (field === "extra-envelope")
      Reflect.set(value, "signature", "TEST_ONLY-never-copy");
    if (field === "changed-charity") value.scope = { ...scope, charity: false };
    if (field === "array-row") Reflect.set(value.data, "0", []);
    expect(() =>
      observeNftCatalogPage(field === "null-page" ? null : value, scope),
    ).toThrow();
  });
  it("keeps chain, full token integer and nanosecond source time exact in a detached record", () => {
    const value = page(
      "2026-10-10T01:00:00.123456789Z",
      ((1n << 256n) - 1n).toString(),
    );
    const output = observeNftCatalogPage(value, scope);
    expect(output[0]).toMatchObject({
      chain: "ethereum",
      tokenId: ((1n << 256n) - 1n).toString(),
      observedAt: value.observedAt,
    });
    value.data[0]!.name = "Mutated";
    expect(output[0]!.name).toBe("TEST ONLY");
  });
  it("preserves the first same-page observation and never refreshes it from a duplicate", () => {
    const value = page();
    value.data.push({ ...value.data[0]!, name: "Later duplicate" });
    expect(observeNftCatalogPage(value, scope)).toHaveLength(1);
    expect(observeNftCatalogPage(value, scope)[0]!.name).toBe("TEST ONLY");
  });
  it("refuses appending a different chain without altering existing records", () => {
    const previous = observeNftCatalogPage(page(), scope);
    const baseScope = { ...scope, chain: "base" as const };
    const incoming = observeNftCatalogPage(
      { ...page(), scope: baseScope },
      baseScope,
    );
    expect(() => mergeNftCatalogPage(previous, incoming, true)).toThrow();
    expect(previous[0]!.chain).toBe("ethereum");
  });
  it("retains existing observations for an empty next page", () => {
    const previous = observeNftCatalogPage(page(), scope);
    expect(mergeNftCatalogPage(previous, [], true)).toEqual(previous);
  });
});
