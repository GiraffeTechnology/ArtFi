import { z } from "zod";
import { isAddress } from "viem";
import {
  isRWASourceEvidence,
  type RWASourceEvidence,
} from "./rwa-source-evidence";
const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) =>
        value.trim() === value &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),
    );
const address = z
  .string()
  .refine(
    (value) => isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value),
  );
const publicURL = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.hash
      );
    } catch {
      return false;
    }
  });
export const rwaPublicationAssetSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    title: text(2, 120),
    artist: text(2, 120),
    year: z
      .number()
      .int()
      .min(1000)
      .max(new Date().getUTCFullYear() + 1),
    medium: text(2, 160),
    location: text(2, 160),
    description: text(20, 2000),
    imageUrl: z.union([publicURL, z.literal("")]).default(""),
    section: z.enum(["whole", "fractional"]),
    rights: text(20, 4000),
    provenance: z.array(text(3, 512)).min(1).max(20),
    binding: z
      .object({
        chainId: z.literal(560048),
        collectionAddress: address,
        tokenId: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,77})$/)
          .refine((value) => BigInt(value) < 1n << 256n),
        assetId: text(1, 256).optional(),
        underlyingAssetId: text(3, 256),
        fractionTokenAddress: address.optional(),
        vaultAddress: address.optional(),
        marketAddress: address.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (
      asset.section === "fractional" &&
      (!asset.binding.fractionTokenAddress || !asset.binding.vaultAddress)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Fractional activation requires the source-approved fraction token and vault.",
      });
    if (
      asset.section === "whole" &&
      (asset.binding.fractionTokenAddress || asset.binding.vaultAddress)
    )
      ctx.addIssue({
        code: "custom",
        message: "Whole receipts do not accept fraction bindings.",
      });
  });
export type RWAPublicationAsset = z.infer<typeof rwaPublicationAssetSchema>;
export const rwaSourceEvidenceSchema = z.custom<RWASourceEvidence>(
  isRWASourceEvidence,
  {
    message:
      "Import a complete source evidence envelope containing only public claim fields and signature r/s. Signing keys, tokens and unknown fields are not accepted.",
  },
);
export const rwaPublicationSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    asset: rwaPublicationAssetSchema,
    evidence: rwaSourceEvidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.asset.section !== value.evidence.section ||
      value.asset.binding.underlyingAssetId !==
        value.evidence.underlyingAssetId ||
      value.asset.rights !== value.evidence.rights
    )
      ctx.addIssue({
        code: "custom",
        message:
          "The source evidence must assert this exact model, underlying asset and rights.",
      });
  });
export type RWAPublication = z.infer<typeof rwaPublicationSchema>;
export type RWAPublicationReview = {
  asset: RWAPublicationAsset;
  contextHash: `0x${string}`;
  executable: false;
};
export function parsePublicAsset(text: string): RWAPublicationAsset {
  if (text.length > 32000)
    throw new Error("Public asset metadata is too large.");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Import valid public asset metadata JSON.");
  }
  const result = rwaPublicationAssetSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "Public asset metadata is incomplete or contains unsupported fields. Never include source signing keys, credentials or private documents.",
    );
  return result.data;
}
export function parseSourceEvidence(text: string): RWASourceEvidence {
  if (text.length > 16000)
    throw new Error("The source evidence envelope is too large.");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Import the source's public evidence envelope as JSON.");
  }
  if (!isRWASourceEvidence(input))
    throw new Error(
      "The source envelope contains unsupported or missing fields. Private keys, API tokens and seeds are never accepted.",
    );
  return input;
}
export function rwaPublicationPath(path: string[], method: string) {
  if (path.length === 1 && path[0] === "drafts" && method === "POST")
    return "/v1/user/rwa/catalog-drafts";
  if (
    path.length === 2 &&
    path[0] === "assets" &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(path[1]) &&
    method === "PUT"
  )
    return `/v1/user/rwa/assets/${path[1]}`;
  return undefined;
}
export function parsePendingPublication(
  text: string,
): { key: string; body: RWAPublication } | undefined {
  if (text.length > 64000) return undefined;
  try {
    const value = JSON.parse(text);
    if (
      Object.keys(value).some((key) => !["key", "body"].includes(key)) ||
      typeof value.key !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(value.key)
    )
      return undefined;
    const body = rwaPublicationSchema.safeParse(value.body);
    return body.success ? { key: value.key, body: body.data } : undefined;
  } catch {
    return undefined;
  }
}
