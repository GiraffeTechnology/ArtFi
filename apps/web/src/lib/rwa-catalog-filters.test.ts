import { describe, expect, it } from "vitest";
import { rwaCatalogFixture } from "../test/rwa-catalog-fixture";
import {
  catalogFilterPage,
  catalogFilterQuery,
  emptyCatalogFilters,
} from "./rwa-catalog-filters";
const address = "0x12345678901234567890123456789012aAbB0011";
const max = ((1n << 256n) - 1n).toString();
const request = (values: Record<string, string> = {}) =>
  new URLSearchParams({
    section: "whole",
    page: "1",
    pageSize: "12",
    q: "",
    sort: "updated",
    ...values,
  });
const page = () => ({
  data: [rwaCatalogFixture()],
  total: 1,
  page: 1,
  pageSize: 12,
});
describe("catalog structured discovery filters", () => {
  it("keeps zero and maximum uint256 IDs exact and normalizes address filters only", () => {
    for (const tokenId of ["0", max]) {
      const result = catalogFilterQuery("whole", {
        ...emptyCatalogFilters(),
        tokenId,
        collectionAddress: " " + address + " ",
        chainId: "560048",
      });
      expect(result.get("tokenId")).toBe(tokenId);
      expect(result.get("collectionAddress")).toBe(address.toLowerCase());
    }
  });
  it.each(["01", "-1", "1e3", "1.5", (1n << 256n).toString()])(
    "refuses ambiguous or overflowing token ID %s",
    (tokenId) =>
      expect(() =>
        catalogFilterQuery("whole", { ...emptyCatalogFilters(), tokenId }),
      ).toThrow(),
  );
  it("refuses zero addresses, unsupported chains and whole/fraction filter confusion", () => {
    for (const fields of [
      { collectionAddress: "0x" + "0".repeat(40) },
      { chainId: "1" },
      { chainId: "0560048" },
      { fractionTokenAddress: address },
    ] as Partial<ReturnType<typeof emptyCatalogFilters>>[])
      expect(() =>
        catalogFilterQuery("whole", { ...emptyCatalogFilters(), ...fields }),
      ).toThrow();
    expect(
      catalogFilterQuery("fractional", {
        ...emptyCatalogFilters(),
        fractionTokenAddress: address,
      }).get("fractionTokenAddress"),
    ).toBe(address.toLowerCase());
    expect(catalogFilterQuery("whole", emptyCatalogFilters()).toString()).toBe(
      "",
    );
  });
  it("preserves source and rights metadata without promoting revoked evidence", () => {
    const response = page();
    response.data[0].grounding.status = "revoked";
    expect(catalogFilterPage(response, request())).toEqual(response);
  });
  it("refuses records from other section, chain, collection, token or fraction bindings", () => {
    for (const filters of [
      { section: "fractional" },
      { chainId: "1" },
      { tokenId: "2" },
      { collectionAddress: address },
      { fractionTokenAddress: address },
    ] as Record<string, string>[])
      expect(() => catalogFilterPage(page(), request(filters))).toThrow(
        "binding",
      );
  });
  it("admits case-insensitive address filters and exact full-width token strings", () => {
    const response = page();
    response.data[0].binding.collectionAddress = address;
    response.data[0].binding.tokenId = max;
    expect(
      catalogFilterPage(
        response,
        request({ collectionAddress: address.toLowerCase(), tokenId: max }),
      ).data[0].binding.tokenId,
    ).toBe(max);
  });
  it("refuses wrong page attribution and impossible result counts", () => {
    for (const response of [
      { ...page(), page: 2 },
      { ...page(), pageSize: 25 },
      { ...page(), total: 0 },
      {
        ...page(),
        data: Array.from({ length: 13 }, () => rwaCatalogFixture()),
        total: 13,
      },
    ])
      expect(() => catalogFilterPage(response, request())).toThrow("page");
    expect(
      catalogFilterPage(
        { data: [], total: 0, page: 1, pageSize: 12 },
        request(),
      ).data,
    ).toEqual([]);
  });
});
