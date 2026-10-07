import { z } from "zod";

// Public Oracle read projections, pinned to Oracle main 59295e82. Unknown fields are
// stripped, including commitments and warehouse identifiers. No holder address exists.
export const oracleStatusSchema = z.enum([
  "VALID",
  "INVALID",
  "TRANSFER_PENDING",
  "FROZEN",
  "REVOKED",
  "EXPIRED",
  "REVIEW_REQUIRED",
  "NOT_VERIFIED",
]);
const assetId = z.string().regex(/^[A-Za-z0-9_-]{3,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const version = z.number().int().positive().safe();
const reference = z.string().min(1).max(256);
const settlement = {
  settlementId: assetId.optional(),
  settlementSnapshotHash: hash.optional(),
};
export const oracleBindingSchema = z.object({
  chainId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  contract: z.string().regex(/^[A-Za-z0-9:_-]{3,128}$/),
  tokenId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  assetId,
});
export const oracleCertificateSchema = z.object({
  assetId,
  tokenId: z.string().min(1).max(128),
  certificateVersion: version,
  certificateHash: hash,
  previousCertificateHash: hash.nullable(),
  wenbaoChangeRef: reference,
  warehouseReceiptHash: hash,
  effectiveAt: date,
  supersededAt: date.nullable().optional(),
  status: z.enum(["CURRENT", "SUPERSEDED", "REVOKED"]),
  ...settlement,
});
export const oracleAssetSchema = z.object({
  assetId,
  assetFingerprintHash: hash,
  wenbaoRegistryRef: reference,
  classificationCode: z.string().max(64).optional(),
  transferEligibility: oracleStatusSchema,
  warehouseReceiptHash: hash,
  currentCertificateHash: hash,
  currentCertificateVersion: version,
  encumbranceStatus: z.string().max(64),
  oracleStatus: oracleStatusSchema,
  updatedAt: date,
  ...settlement,
});
export const oracleWarehouseSchema = z.object({
  assetId,
  warehouseReceiptHash: hash,
  warehouseStatus: z.enum([
    "IN_CUSTODY",
    "FROZEN",
    "RELEASE_PENDING",
    "RELEASED",
    "REVIEW_REQUIRED",
  ]),
  encumbranceStatus: z.string().max(64).optional(),
  observedAt: date,
  ...settlement,
});
export const oracleTokenReadSchema = z.object({
  binding: oracleBindingSchema,
  status: oracleStatusSchema,
  currentCertificate: oracleCertificateSchema.nullable(),
});
export const oracleAssetReadSchema = z.object({
  asset: oracleAssetSchema,
  status: oracleStatusSchema,
  currentCertificate: oracleCertificateSchema.nullable(),
  warehouse: oracleWarehouseSchema.nullable(),
});
export const oracleReadErrorSchema = z.enum([
  "UNKNOWN_ASSET",
  "BINDING_ELSEWHERE",
  "BINDING_NOT_CONFIGURED",
  "BINDING_INVALID",
  "ORACLE_NOT_CONFIGURED",
  "ORACLE_CONFIG_INVALID",
  "TOKEN_NOT_FOUND",
  "ASSET_NOT_FOUND",
  "ORACLE_RECORD_GONE",
  "BINDING_MISMATCH",
  "ORACLE_UNAVAILABLE",
  "ORACLE_TIMEOUT",
  "ORACLE_INVALID_RESPONSE",
]);
export type OracleReadError = z.infer<typeof oracleReadErrorSchema>;
export const oracleProjectionSchema = z.object({
  ok: z.literal(true),
  token: oracleTokenReadSchema,
  asset: oracleAssetReadSchema,
  readAt: date,
});
export type OracleProjection = z.infer<typeof oracleProjectionSchema>;
export const oracleReadResponseSchema = z.discriminatedUnion("ok", [
  oracleProjectionSchema,
  z.object({ ok: z.literal(false), code: oracleReadErrorSchema }),
]);
export type OracleReadResponse = z.infer<typeof oracleReadResponseSchema>;

export const oracleReadMessages: Record<OracleReadError, string> = {
  UNKNOWN_ASSET:
    "This artwork page is not recognized. No Oracle record was requested.",
  BINDING_ELSEWHERE:
    "The configured whole-artwork token belongs to another page. No Oracle record was requested for this artwork.",
  BINDING_NOT_CONFIGURED:
    "No whole-artwork token binding is configured for this page.",
  BINDING_INVALID:
    "The whole-artwork token binding is invalid. No Oracle record was requested.",
  ORACLE_NOT_CONFIGURED:
    "The Oracle read service is not configured for this deployment.",
  ORACLE_CONFIG_INVALID: "The Oracle read service configuration is invalid.",
  TOKEN_NOT_FOUND:
    "The Oracle service returned 404 for this token. Its binding is unavailable; this does not establish a registry rejection.",
  ASSET_NOT_FOUND:
    "The Oracle service returned 404 for the bound asset. Its record is unavailable; this does not establish a registry rejection.",
  ORACLE_RECORD_GONE:
    "The Oracle service returned 410. The requested record is no longer available; no current rights are inferred.",
  BINDING_MISMATCH:
    "The Oracle response does not match this page's token or asset binding. Its facts are not displayed.",
  ORACLE_UNAVAILABLE:
    "The Oracle read service could not be reached or returned an error. No current Oracle facts are available.",
  ORACLE_TIMEOUT:
    "The Oracle read timed out. No current Oracle facts are available.",
  ORACLE_INVALID_RESPONSE:
    "The Oracle service returned an unsupported or invalid response. Its facts are not displayed.",
};
