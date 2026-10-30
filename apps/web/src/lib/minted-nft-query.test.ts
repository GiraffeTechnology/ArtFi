import { describe, it, expect } from "vitest";
import {
  emptyMintFilters,
  mintCatalogQuery,
  readMintCatalogPage,
} from "./minted-nft-query";
const collection = "0x1000000000000000000000000000000000000001";
const item = {
  standard: "ERC-721",
  collectionAddress: collection,
  tokenId: "0",
  transactionHash: "0x" + "1".repeat(64),
  blockNumber: 100,
  observedAt: "2026-10-15T20:00:00Z",
};
const response = () => ({
  runtime: true,
  chainId: 560048,
  total: 1,
  page: 1,
  pageSize: 24,
  data: [{ ...item }],
});
describe("Hoodi mint index discovery", () => {
  it("keeps zero and full-width token IDs in server queries without numeric coercion", () => {
    for (const tokenId of ["0", ((1n << 256n) - 1n).toString()])
      expect(
        mintCatalogQuery({ ...emptyMintFilters(), tokenId }, 1).get("tokenId"),
      ).toBe(tokenId);
  });
  it.each(["01", "-1", "1e3", (1n << 256n).toString()])(
    "refuses noncanonical or overflowing token %s",
    (tokenId) =>
      expect(() =>
        mintCatalogQuery({ ...emptyMintFilters(), tokenId }, 1),
      ).toThrow(),
  );
  it("rejects zero collections and out-of-range pages", () => {
    expect(() =>
      mintCatalogQuery(
        { ...emptyMintFilters(), collectionAddress: "0x" + "0".repeat(40) },
        1,
      ),
    ).toThrow();
    expect(() => mintCatalogQuery(emptyMintFilters(), 1000001)).toThrow();
  });
  it("discards mint-recipient and metadata locators instead of treating them as current holder or preview authority", () => {
    const raw = response();
    Object.assign(raw.data[0], {
      holderAddress: collection,
      metadataUri: "https://example.invalid/private-master",
    });
    expect(
      readMintCatalogPage(raw, mintCatalogQuery(emptyMintFilters(), 1)).data[0],
    ).toEqual(item);
  });
  it("binds each result to the requested standard, collection, token and page", () => {
    const filters = [
      { ...emptyMintFilters(), standard: "ERC-1155" },
      {
        ...emptyMintFilters(),
        collectionAddress: "0x1000000000000000000000000000000000000002",
      },
      { ...emptyMintFilters(), tokenId: "1" },
    ];
    for (const value of filters)
      expect(() =>
        readMintCatalogPage(response(), mintCatalogQuery(value, 1)),
      ).toThrow("binding");
    expect(() =>
      readMintCatalogPage(
        { ...response(), page: 2 },
        mintCatalogQuery(emptyMintFilters(), 1),
      ),
    ).toThrow("page");
  });
  it("rejects fake chain data, duplicate identities and counts that cannot describe the page", () => {
    const query = mintCatalogQuery(emptyMintFilters(), 1);
    for (const raw of [
      { ...response(), runtime: false },
      { ...response(), chainId: 1 },
      { ...response(), data: [item, item], total: 2 },
      { ...response(), total: 0 },
    ])
      expect(() => readMintCatalogPage(raw, query)).toThrow();
    expect(
      readMintCatalogPage({ ...response(), data: [], total: 0 }, query).data,
    ).toEqual([]);
  });
});
