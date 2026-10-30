import { equalAddress, uint, type NftScope, type NftView } from "./model";

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
  chain: NftScope["chain"];
};
function refuse(): never {
  throw new Error(
    "The catalog source, observation time or collection binding is unavailable. Refresh before using these records.",
  );
}
function fields(
  value: unknown,
  allowed: string[],
  required = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        !allowed.includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value"),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    return refuse();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, d]) => [key, d.value]),
  );
}
/** Bind every page record to the selected chain/collection and its original observation. */
export function observeNftCatalogPage(
  raw: unknown,
  scope: NftScope,
): ObservedNft[] {
  const page = fields(raw, ["data", "next", "scope", "source", "observedAt"]);
  const binding = fields(page.scope, [
    "slug",
    "chain",
    "contract",
    "standard",
    "label",
    "charity",
  ]);
  if (
    page.source !== "opensea" ||
    typeof page.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
      page.observedAt,
    ) ||
    !Number.isFinite(Date.parse(page.observedAt)) ||
    new Date(page.observedAt).toISOString().slice(0, 19) !==
      page.observedAt.slice(0, 19) ||
    binding.slug !== scope.slug ||
    binding.chain !== scope.chain ||
    !equalAddress(binding.contract, scope.contract) ||
    binding.standard !== scope.standard ||
    binding.label !== scope.label ||
    binding.charity !== scope.charity ||
    !Array.isArray(page.data) ||
    page.data.length > 24 ||
    (page.next !== null &&
      (typeof page.next !== "string" ||
        !page.next ||
        page.next.length > 2048 ||
        /[\x00-\x1f]/.test(page.next)))
  )
    return refuse();
  const rows: ObservedNft[] = [],
    ids = new Set<string>();
  for (let index = 0; index < page.data.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(
      page.data,
      String(index),
    );
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return refuse();
    const item = fields(
      descriptor.value,
      ["tokenId", "name", "contract", "standard", "collection", "sourceURL"],
      ["tokenId", "name", "contract", "standard", "collection"],
    );
    if (
      !equalAddress(item.contract, scope.contract) ||
      item.standard !== scope.standard ||
      item.collection !== scope.slug ||
      typeof item.name !== "string" ||
      item.name.length > 200
    )
      return refuse();
    let tokenId: string;
    try {
      tokenId = uint(item.tokenId);
    } catch {
      return refuse();
    }
    let sourceURL: string | undefined;
    if (item.sourceURL !== undefined) {
      if (typeof item.sourceURL !== "string" || item.sourceURL.length > 2048)
        return refuse();
      try {
        const url = new URL(item.sourceURL);
        if (
          url.protocol !== "https:" ||
          !["opensea.io", "www.opensea.io"].includes(url.hostname) ||
          url.username ||
          url.password
        )
          return refuse();
        sourceURL = item.sourceURL;
      } catch {
        return refuse();
      }
    }
    // Later duplicates do not refresh or replace the first observation of an asset.
    if (ids.has(tokenId)) continue;
    ids.add(tokenId);
    rows.push({
      tokenId,
      name: item.name,
      contract: scope.contract,
      standard: scope.standard,
      collection: scope.slug,
      ...(sourceURL ? { sourceURL } : {}),
      source: "opensea",
      observedAt: page.observedAt,
      chain: scope.chain,
    });
  }
  return rows;
}
export function mergeNftCatalogPage(
  previous: ObservedNft[],
  incoming: ObservedNft[],
  append: boolean,
) {
  if (!append) return incoming;
  const first = previous[0] ?? incoming[0];
  if (
    first &&
    [...previous, ...incoming].some(
      (row) =>
        row.chain !== first.chain ||
        row.collection !== first.collection ||
        !equalAddress(row.contract, first.contract) ||
        row.standard !== first.standard,
    )
  )
    return refuse();
  const seen = new Set(previous.map((row) => row.tokenId));
  return [
    ...previous,
    ...incoming.filter((row) => {
      if (seen.has(row.tokenId)) return false;
      seen.add(row.tokenId);
      return true;
    }),
  ];
}
