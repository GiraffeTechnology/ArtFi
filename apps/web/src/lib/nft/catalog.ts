import type { NftScope, NftView } from "./model";

export type NftCatalogPage = {
  data: NftView[];
  next: string | null;
  scope: NftScope;
  source: "opensea";
  observedAt: string;
};
export type ObservedNft = NftView & {
  source: "opensea";
  observedAt: string;
};

/** Keep each page's observation attached to its records, never a guessed browser time. */
export function observeNftCatalogPage(
  page: NftCatalogPage,
  scope: NftScope,
): ObservedNft[] {
  if (
    page.source !== "opensea" ||
    typeof page.observedAt !== "string" ||
    !Number.isFinite(Date.parse(page.observedAt)) ||
    page.scope?.slug !== scope.slug ||
    page.scope?.chain !== scope.chain ||
    page.scope?.contract?.toLowerCase() !== scope.contract.toLowerCase() ||
    page.scope?.standard !== scope.standard
  )
    throw new Error(
      "The catalog source, observation time or collection binding is unavailable. Refresh before using these records.",
    );
  return page.data.map((item) => ({
    ...item,
    source: page.source,
    observedAt: page.observedAt,
  }));
}

export function mergeNftCatalogPage(
  previous: ObservedNft[],
  incoming: ObservedNft[],
  append: boolean,
) {
  if (!append) return incoming;
  // A duplicate on a later page does not refresh a previously displayed observation.
  return [
    ...previous,
    ...incoming.filter(
      (item) => !previous.some((old) => old.tokenId === item.tokenId),
    ),
  ];
}
