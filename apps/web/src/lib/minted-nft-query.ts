import { z } from "zod";
import { isAddress, zeroAddress } from "viem";
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
const pageSchema = z.object({
  runtime: z.literal(true),
  chainId: z.literal(560048),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().min(1).max(1000000),
  pageSize: z.number().int().min(1).max(100),
  data: z
    .array(
      z.object({
        standard: z.enum(["ERC-721", "ERC-1155"]),
        collectionAddress: address,
        tokenId: uint,
        transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        blockNumber: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        observedAt: z
          .string()
          .refine((value) => Number.isFinite(Date.parse(value))),
      }),
    )
    .max(100),
});
export type MintCatalogPage = z.infer<typeof pageSchema>;
export type MintCatalogFilters = {
  standard: string;
  collectionAddress: string;
  tokenId: string;
  sort: "newest" | "oldest";
};
export function emptyMintFilters(): MintCatalogFilters {
  return { standard: "", collectionAddress: "", tokenId: "", sort: "newest" };
}
export function mintCatalogQuery(filters: MintCatalogFilters, page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
    throw new Error("Invalid mint page.");
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "24",
    sort: filters.sort,
  });
  if (!["newest", "oldest"].includes(filters.sort))
    throw new Error("Invalid mint sort.");
  if (filters.standard) {
    if (!["ERC-721", "ERC-1155"].includes(filters.standard))
      throw new Error("Choose ERC-721 or ERC-1155.");
    query.set("standard", filters.standard);
  }
  const collection = filters.collectionAddress.trim(),
    token = filters.tokenId.trim();
  if (collection) {
    if (!address.safeParse(collection).success)
      throw new Error("Enter a nonzero collection address.");
    query.set("collectionAddress", collection.toLowerCase());
  }
  if (token) {
    if (!uint.safeParse(token).success)
      throw new Error("Enter a canonical decimal uint256 token ID.");
    query.set("tokenId", token);
  }
  return query;
}
export function readMintCatalogPage(raw: unknown, query: URLSearchParams) {
  const page = pageSchema.parse(raw);
  if (
    page.page !== Number(query.get("page")) ||
    page.pageSize !== Number(query.get("pageSize")) ||
    page.data.length > page.pageSize ||
    page.data.length > Math.max(0, page.total - (page.page - 1) * page.pageSize)
  )
    throw new Error("The mint index response belongs to another page.");
  const seen = new Set<string>();
  for (const item of page.data) {
    if (
      (query.has("standard") && item.standard !== query.get("standard")) ||
      (query.has("collectionAddress") &&
        item.collectionAddress.toLowerCase() !==
          query.get("collectionAddress")?.toLowerCase()) ||
      (query.has("tokenId") && item.tokenId !== query.get("tokenId"))
    )
      throw new Error("The mint index returned a different asset binding.");
    const key = JSON.stringify([
      item.standard,
      item.collectionAddress.toLowerCase(),
      item.tokenId,
    ]);
    if (seen.has(key))
      throw new Error("The mint index contains duplicate asset identities.");
    seen.add(key);
  }
  return page;
}
