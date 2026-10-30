import {
  rwaCatalogPageSchema,
  rwaCatalogQuery,
  type RwaSection,
} from "./rwa-catalog";

export type CatalogFilterDraft = {
  chainId: string;
  collectionAddress: string;
  tokenId: string;
  fractionTokenAddress: string;
};
export function emptyCatalogFilters(): CatalogFilterDraft {
  return {
    chainId: "",
    collectionAddress: "",
    tokenId: "",
    fractionTokenAddress: "",
  };
}
// Reuse the public catalog contract. Token IDs remain decimal strings throughout.
export function catalogFilterQuery(
  section: RwaSection,
  draft: CatalogFilterDraft,
) {
  const result = new URLSearchParams();
  for (const key of [
    "chainId",
    "collectionAddress",
    "tokenId",
    "fractionTokenAddress",
  ] as const) {
    const value = draft[key].trim();
    if (!value) continue;
    if (key === "chainId" && value !== "560048")
      throw new Error("The supported catalog chain is Hoodi (560048).");
    if (key === "fractionTokenAddress" && section !== "fractional")
      throw new Error(
        "Fraction token filters apply only to fractional assets.",
      );
    result.set(key, key.endsWith("Address") ? value.toLowerCase() : value);
  }
  try {
    return rwaCatalogQuery(result);
  } catch {
    throw new Error(
      "Use nonzero EVM addresses and a canonical decimal uint256 token ID.",
    );
  }
}

// This admits display results, not trading or source-evidence authority.
export function catalogFilterPage(raw: unknown, request: URLSearchParams) {
  const expected = rwaCatalogQuery(request);
  const result = rwaCatalogPageSchema.parse(raw);
  const page = Number(expected.get("page")),
    size = Number(expected.get("pageSize"));
  if (
    result.page !== page ||
    result.pageSize !== size ||
    result.data.length > size ||
    result.data.length > Math.max(0, result.total - (page - 1) * size)
  )
    throw new Error("The catalog response does not match the requested page.");
  for (const asset of result.data) {
    if (
      asset.section !== expected.get("section") ||
      (expected.has("chainId") &&
        String(asset.binding.chainId) !== expected.get("chainId")) ||
      (expected.has("tokenId") &&
        asset.binding.tokenId !== expected.get("tokenId"))
    )
      throw new Error("The catalog returned a different asset binding.");
    for (const key of ["collectionAddress", "fractionTokenAddress"] as const)
      if (
        expected.has(key) &&
        asset.binding[key]?.toLowerCase() !== expected.get(key)?.toLowerCase()
      )
        throw new Error("The catalog returned a different asset binding.");
  }
  return result;
}
