import { z } from "zod";

// Oracle application-facing JSON, never an ArtFi ERC-8415/Kit adapter.
// Integers cross the boundary as exact decimal strings.
export const projectionUint64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < 2n ** 64n,
  );
export const projectionUint256 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n,
  );
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const projectionSourceSchema = z.object({
  chainId: projectionUint256,
  contract: address,
  registerId: hash.refine((value) => !/^0x0{64}$/i.test(value)),
});
export const projectionEntrySchema = z.object({
  recordCommitment: hash,
  previousCommitment: hash,
  registryReference: hash,
  holder: address,
  version: projectionUint64,
  effectiveAt: projectionUint64,
  supersededAt: projectionUint64,
});
export const projectionReadErrorSchema = z.enum([
  "UNKNOWN_ASSET",
  "BINDING_NOT_CONFIGURED",
  "BINDING_ELSEWHERE",
  "BINDING_INVALID",
  "ORACLE_NOT_CONFIGURED",
  "ORACLE_CONFIG_INVALID",
  "INSTANT_INVALID",
  "INSTANT_NOT_COVERED",
  "UNKNOWN_TOKEN",
  "EMPTY_PROJECTION",
  "PROJECTION_SOURCE_NOT_CONFIGURED",
  "PROJECTION_SOURCE_UNAVAILABLE",
  "PROJECTION_SOURCE_MALFORMED",
  "PROJECTION_READ_UNAVAILABLE",
  "PROJECTION_TIMEOUT",
  "PROJECTION_BINDING_MISMATCH",
]);
export type ProjectionReadError = z.infer<typeof projectionReadErrorSchema>;
const failure = z.object({
  ok: z.literal(false),
  code: projectionReadErrorSchema,
});
const observed = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    failure,
  ]);
export const projectionReadResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    tokenId: projectionUint256,
    instant: projectionUint64,
    source: projectionSourceSchema,
    entryCount: projectionUint64,
    entry: observed(projectionEntrySchema),
    holder: observed(address),
    finality: observed(z.boolean()),
    position: observed(address.nullable()),
    readAt: z.string().datetime(),
  }),
  failure,
]);
export type ProjectionReadResponse = z.infer<
  typeof projectionReadResponseSchema
>;
export type ProjectionRead = Extract<ProjectionReadResponse, { ok: true }>;
export const projectionReadMessages: Record<ProjectionReadError, string> = {
  UNKNOWN_ASSET: "This artwork is not in the catalogue.",
  BINDING_NOT_CONFIGURED: "No whole-artwork token is configured for this page.",
  BINDING_ELSEWHERE:
    "The configured whole-artwork token belongs to another page.",
  BINDING_INVALID: "The configured whole-artwork token identity is invalid.",
  ORACLE_NOT_CONFIGURED: "The Oracle read service is not configured.",
  ORACLE_CONFIG_INVALID: "The Oracle read service configuration is invalid.",
  INSTANT_INVALID: "Enter an exact non-negative Unix timestamp within uint64.",
  INSTANT_NOT_COVERED: "The register projection does not cover this instant.",
  UNKNOWN_TOKEN: "The Oracle projection has no such token.",
  EMPTY_PROJECTION: "No register entry is available for this token.",
  PROJECTION_SOURCE_NOT_CONFIGURED:
    "The Oracle projection source is not configured.",
  PROJECTION_SOURCE_UNAVAILABLE: "The Oracle projection source did not answer.",
  PROJECTION_SOURCE_MALFORMED: "The Oracle projection response is invalid.",
  PROJECTION_READ_UNAVAILABLE:
    "The Oracle projection read is unavailable. Retry the read.",
  PROJECTION_TIMEOUT: "The Oracle projection read timed out. Retry the read.",
  PROJECTION_BINDING_MISMATCH:
    "The Oracle projection does not match this artwork's configured identity.",
};

export function projectionReadView(query: {
  isPaused: boolean;
  isPending: boolean;
  isFetching: boolean;
  data?: ProjectionReadResponse;
}) {
  if (query.isPaused) return { phase: "paused" as const };
  if (query.isPending || query.isFetching) return { phase: "loading" as const };
  return {
    phase: "settled" as const,
    result: query.data ?? {
      ok: false as const,
      code: "PROJECTION_READ_UNAVAILABLE" as const,
    },
  };
}
