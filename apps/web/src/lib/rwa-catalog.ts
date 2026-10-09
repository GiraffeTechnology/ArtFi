import { z } from "zod";
import { isAddress, zeroAddress } from "viem";

export const rwaSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const text = (limit: number) => z.string().max(limit);
const address = z
  .string()
  .refine(
    (value) =>
      isAddress(value, { strict: false }) &&
      value.toLowerCase() !== zeroAddress,
  );
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) < 1n << 256n);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
export const rwaAssetSchema = z.object({
  slug: rwaSlugSchema,
  title: text(240).min(1),
  artist: text(200).min(1),
  year: z.number().int().min(1).max(9999),
  medium: text(240),
  location: text(200),
  description: text(8000),
  imageUrl: text(2048).optional(),
  section: z.enum(["whole", "fractional"]),
  rights: text(8000).min(1),
  provenance: z.array(text(2000)).max(100),
  binding: z.object({
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    collectionAddress: address,
    tokenId: uint,
    assetId: text(256).optional(),
    underlyingAssetId: text(256).optional(),
    fractionTokenAddress: address.optional(),
    vaultAddress: address.optional(),
    marketAddress: address.optional(),
  }),
  grounding: z.object({
    status: z.enum([
      "verified",
      "expired",
      "revoked",
      "source-unavailable",
      "not-yet-valid",
    ]),
    mode: z.enum(["LIVE", "TEST_ONLY"]),
    sourceAssetId: text(256).optional(),
    evidenceId: text(256).optional(),
    registryRecord: z
      .object({
        reference: text(2000),
        version: text(128),
        observedAt: z.number().int().nonnegative(),
      })
      .optional(),
    sourceId: text(128).min(1),
    sourceName: text(200).min(1),
    sourceKind: text(80).min(1),
    sourceReference: text(2000).min(1),
    evidenceSha256: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/),
    validFrom: timestamp,
    validUntil: timestamp,
    verifiedAt: timestamp,
    registryBacked: z.boolean(),
  }),
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type RwaAsset = z.infer<typeof rwaAssetSchema>;
export type RwaSection = RwaAsset["section"];
export const rwaCatalogPageSchema = z.object({
  data: z.array(rwaAssetSchema).max(50),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
});
export type RwaCatalogPage = z.infer<typeof rwaCatalogPageSchema>;
export class RwaCatalogError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RwaCatalogError";
  }
}
export function rwaCatalogQuery(input: URLSearchParams) {
  const result = new URLSearchParams();
  const allowed = [
    "section",
    "q",
    "page",
    "pageSize",
    "sort",
    "fractionTokenAddress",
    "chainId",
    "collectionAddress",
    "tokenId",
  ];
  for (const key of input.keys())
    if (!allowed.includes(key) || input.getAll(key).length !== 1)
      throw new RwaCatalogError(400, "Invalid asset-catalog query.");
  for (const [key, value] of input) {
    const valid =
      key === "section"
        ? ["whole", "fractional"].includes(value)
        : key === "sort"
          ? ["updated", "title"].includes(value)
          : key === "q"
            ? value.length <= 100 && !/[\x00-\x1f]/.test(value)
            : ["fractionTokenAddress", "collectionAddress"].includes(key)
              ? address.safeParse(value).success
              : key === "tokenId"
                ? uint.safeParse(value).success
                : /^[1-9][0-9]{0,15}$/.test(value) &&
                  Number.isSafeInteger(Number(value)) &&
                  (key !== "pageSize" || Number(value) <= 50);
    if (!valid) throw new RwaCatalogError(400, "Invalid asset-catalog query.");
    result.set(key, value);
  }
  return result;
}
export function rwaAssetIdentity(asset: RwaAsset) {
  return JSON.stringify([
    asset.section,
    asset.binding.chainId,
    asset.binding.collectionAddress.toLowerCase(),
    asset.binding.tokenId,
    asset.binding.assetId ?? "",
    asset.binding.underlyingAssetId ?? "",
    asset.binding.fractionTokenAddress?.toLowerCase() ?? "",
    asset.binding.vaultAddress?.toLowerCase() ?? "",
    asset.binding.marketAddress?.toLowerCase() ?? "",
    asset.grounding.sourceId,
    asset.grounding.mode,
    asset.rights,
  ]);
}
export type RwaTradeBinding = {
  section: RwaSection;
  chainId: number;
  marketAddress: string;
  collectionAddress?: string;
  tokenId?: string;
  fractionTokenAddress?: string;
  slug?: string;
  identity?: string;
};
export function assertRwaAssetBinding(
  asset: RwaAsset,
  expected: RwaTradeBinding,
) {
  const same = (a: string | undefined, b: string | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (
    asset.section !== expected.section ||
    asset.binding.chainId !== expected.chainId ||
    !same(asset.binding.marketAddress, expected.marketAddress) ||
    (expected.slug !== undefined && asset.slug !== expected.slug) ||
    (expected.section === "whole"
      ? !same(asset.binding.collectionAddress, expected.collectionAddress) ||
        asset.binding.tokenId !== expected.tokenId
      : !same(
          asset.binding.fractionTokenAddress,
          expected.fractionTokenAddress,
        ))
  )
    throw new RwaCatalogError(
      409,
      "The approved source record does not match this asset and settlement binding.",
    );
  if (
    expected.identity !== undefined &&
    rwaAssetIdentity(asset) !== expected.identity
  )
    throw new RwaCatalogError(
      409,
      "The source identity or rights changed. Refresh and review the asset again.",
    );
  if (asset.grounding.status !== "verified")
    throw new RwaCatalogError(
      409,
      "Current approved-source correspondence evidence is unavailable or inactive. New trading is unavailable; ownership exits remain available.",
    );
}
export async function assertRwaTradingEvidence(
  expected: RwaTradeBinding,
  fetcher: typeof fetch = fetch,
) {
  let url: string;
  if (expected.slug)
    url = `/api/rwa/assets/${encodeURIComponent(expected.slug)}`;
  else {
    const query = new URLSearchParams({
      section: expected.section,
      chainId: String(expected.chainId),
      page: "1",
      pageSize: "2",
    });
    if (expected.section === "whole") {
      query.set("collectionAddress", expected.collectionAddress || "");
      query.set("tokenId", expected.tokenId || "");
    } else
      query.set("fractionTokenAddress", expected.fractionTokenAddress || "");
    url = `/api/rwa/assets?${query}`;
  }
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new RwaCatalogError(
      response.status,
      "Approved-source asset evidence is unavailable. No new wallet action was requested.",
    );
  const raw: unknown = await response.json();
  let asset: RwaAsset;
  if (expected.slug) asset = rwaAssetSchema.parse(raw);
  else {
    const page = rwaCatalogPageSchema.parse(raw);
    if (page.total !== 1 || page.data.length !== 1)
      throw new RwaCatalogError(
        409,
        "No unique approved source binding exists for this token.",
      );
    asset = page.data[0];
  }
  assertRwaAssetBinding(asset, expected);
  return asset;
}
