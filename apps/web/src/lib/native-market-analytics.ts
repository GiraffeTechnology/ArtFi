import { z } from "zod";
import type { RwaAsset } from "./rwa-catalog";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((x) => !/^0x0{40}$/i.test(x));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((x) => BigInt(x) < 1n << 256n);
const positive = uint.refine((x) => BigInt(x) > 0n);
const total = z.string().regex(/^(0|[1-9][0-9]{0,81})$/);
const count = z.number().int().min(0).max(20_000);
const point = z
  .object({
    transactionHash: hash,
    blockHash: hash,
    blockNumber: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((x) => BigInt(x) < 1n << 64n),
    logIndex: z.number().int().min(0).max(4_294_967_295),
    unitPrice: positive,
    quantity: positive,
    payment: positive,
  })
  .strict();
const analyticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainId: z.literal(560048),
    marketAddress: address,
    assetToken: address,
    paymentToken: address,
    status: z.enum([
      "no_matched_fills",
      "observed_indexed_subset",
      "incomplete_indexed_subset",
      "history_limit_exceeded",
      "conflicting_indexed_evidence",
    ]),
    scope: z.literal("indexed_native_fraction_fills"),
    coverage: z.literal(
      "bounded_indexed_projection_not_complete_chain_history",
    ),
    finality: z.literal("indexer_confirmed_not_independent_chain_finality"),
    tradeCount: count,
    quantity: total.nullable(),
    payment: total.nullable(),
    distinctParticipants: count,
    pendingFillCount: count,
    removedFillCount: count,
    unmatchedFillCount: count,
    priceHistory: z.array(point).max(200),
    priceHistoryTruncated: z.boolean(),
    holderDistribution: z.null(),
    reasons: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((x) => !/[\u0000-\u001f\u007f]/.test(x)),
      )
      .max(16),
  })
  .strict();
export type NativeMarketAnalytics = z.infer<typeof analyticsSchema>;
export type NativeAnalyticsScope = {
  chainId: "560048";
  marketAddress: string;
  assetToken: string;
  paymentToken: string;
};
export class NativeAnalyticsError extends Error {
  constructor(
    public readonly reason:
      "scope" | "unsupported" | "contract" | "context" | "unavailable",
  ) {
    super(
      reason === "context"
        ? "The source record changed. Refresh the asset record before reading analytics."
        : reason === "unsupported"
          ? "Native fractional analytics are unavailable for this asset binding."
          : reason === "scope"
            ? "Enter a nonzero payment-token address different from the fraction token."
            : "Indexed market analytics are unavailable. No sample totals are substituted.",
    );
  }
}
export function nativeAnalyticsScope(
  asset: RwaAsset,
  paymentToken: string,
): NativeAnalyticsScope {
  const b = asset.binding;
  if (
    asset.section !== "fractional" ||
    b.chainId !== 560048 ||
    !address.safeParse(b.marketAddress).success ||
    !address.safeParse(b.fractionTokenAddress).success
  )
    throw new NativeAnalyticsError("unsupported");
  if (
    !address.safeParse(paymentToken).success ||
    paymentToken.toLowerCase() === b.fractionTokenAddress!.toLowerCase()
  )
    throw new NativeAnalyticsError("scope");
  return {
    chainId: "560048",
    marketAddress: b.marketAddress!.toLowerCase(),
    assetToken: b.fractionTokenAddress!.toLowerCase(),
    paymentToken: paymentToken.toLowerCase(),
  };
}
export function parseNativeMarketAnalytics(
  value: unknown,
  expected: NativeAnalyticsScope,
): NativeMarketAnalytics {
  const parsed = analyticsSchema.safeParse(value);
  if (!parsed.success) throw new NativeAnalyticsError("contract");
  const x = parsed.data;
  if (
    x.chainId !== Number(expected.chainId) ||
    x.marketAddress.toLowerCase() !== expected.marketAddress ||
    x.assetToken.toLowerCase() !== expected.assetToken ||
    x.paymentToken.toLowerCase() !== expected.paymentToken ||
    x.assetToken.toLowerCase() === x.paymentToken.toLowerCase()
  )
    throw new NativeAnalyticsError("context");
  const unavailable =
    x.status === "history_limit_exceeded" ||
    x.status === "conflicting_indexed_evidence";
  if (unavailable) {
    if (
      x.quantity !== null ||
      x.payment !== null ||
      x.tradeCount !== 0 ||
      x.distinctParticipants !== 0 ||
      x.priceHistory.length ||
      x.priceHistoryTruncated
    )
      throw new NativeAnalyticsError("contract");
    return x;
  }
  if (
    x.quantity === null ||
    x.payment === null ||
    x.distinctParticipants > x.tradeCount * 2 ||
    (x.tradeCount > 0 && x.distinctParticipants < 2)
  )
    throw new NativeAnalyticsError("contract");
  if (
    x.priceHistoryTruncated
      ? x.priceHistory.length !== 200 || x.tradeCount <= 200
      : x.priceHistory.length !== x.tradeCount
  )
    throw new NativeAnalyticsError("contract");
  if (
    (x.status === "observed_indexed_subset" && x.tradeCount === 0) ||
    (x.status === "no_matched_fills" && x.tradeCount !== 0) ||
    (x.status === "incomplete_indexed_subset" &&
      x.pendingFillCount + x.unmatchedFillCount === 0) ||
    (x.status !== "incomplete_indexed_subset" &&
      x.pendingFillCount + x.unmatchedFillCount !== 0)
  )
    throw new NativeAnalyticsError("contract");
  const ids = new Set<string>();
  let quantity = 0n,
    payment = 0n;
  for (let i = 0; i < x.priceHistory.length; i++) {
    const p = x.priceHistory[i]!;
    const id = p.transactionHash.toLowerCase() + ":" + p.logIndex;
    const prior = x.priceHistory[i - 1];
    if (
      ids.has(id) ||
      BigInt(p.unitPrice) * BigInt(p.quantity) !== BigInt(p.payment) ||
      (prior &&
        (BigInt(prior.blockNumber) > BigInt(p.blockNumber) ||
          (prior.blockNumber === p.blockNumber &&
            (prior.logIndex > p.logIndex ||
              (prior.logIndex === p.logIndex &&
                prior.transactionHash.toLowerCase() >=
                  p.transactionHash.toLowerCase())))))
    )
      throw new NativeAnalyticsError("contract");
    ids.add(id);
    quantity += BigInt(p.quantity);
    payment += BigInt(p.payment);
  }
  if (
    BigInt(x.quantity) < quantity ||
    BigInt(x.payment) < payment ||
    (!x.priceHistoryTruncated &&
      (BigInt(x.quantity) !== quantity || BigInt(x.payment) !== payment))
  )
    throw new NativeAnalyticsError("contract");
  return x;
}
export function parseNativeAnalyticsEnvelope(
  value: unknown,
  expected: {
    scope: NativeAnalyticsScope;
    catalogIdentity: string;
    catalogRevision: number;
  },
) {
  const parsed = z
    .object({
      catalogIdentity: z.string().max(32768),
      catalogRevision: z.number().int().positive(),
      analytics: z.unknown(),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) throw new NativeAnalyticsError("contract");
  if (
    parsed.data.catalogIdentity !== expected.catalogIdentity ||
    parsed.data.catalogRevision !== expected.catalogRevision
  )
    throw new NativeAnalyticsError("context");
  return parseNativeMarketAnalytics(parsed.data.analytics, expected.scope);
}
