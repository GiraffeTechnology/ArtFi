import type { NativeMarketAnalytics } from "../lib/native-market-analytics";
import { rwaCatalogFixture } from "./rwa-catalog-fixture";
export const analyticsPaymentToken =
  "0xdddddddddddddddddddddddddddddddddddddddd";
export function analyticsAssetFixture() {
  const asset = rwaCatalogFixture();
  asset.section = "fractional";
  asset.binding.fractionTokenAddress =
    "0xcccccccccccccccccccccccccccccccccccccccc";
  return asset;
}
export function nativeAnalyticsFixture(): NativeMarketAnalytics {
  const asset = analyticsAssetFixture();
  return {
    schemaVersion: 1,
    chainId: 560048,
    marketAddress: asset.binding.marketAddress!,
    assetToken: asset.binding.fractionTokenAddress!,
    paymentToken: analyticsPaymentToken,
    status: "observed_indexed_subset",
    scope: "indexed_native_fraction_fills",
    coverage: "bounded_indexed_projection_not_complete_chain_history",
    finality: "indexer_confirmed_not_independent_chain_finality",
    tradeCount: 1,
    quantity: "3",
    payment: "27021597764222979",
    distinctParticipants: 2,
    pendingFillCount: 0,
    removedFillCount: 0,
    unmatchedFillCount: 0,
    priceHistory: [
      {
        transactionHash: "0x" + "1".repeat(64),
        blockHash: "0x" + "2".repeat(64),
        blockNumber: "9007199254740993",
        logIndex: 2,
        unitPrice: "9007199254740993",
        quantity: "3",
        payment: "27021597764222979",
      },
    ],
    priceHistoryTruncated: false,
    holderDistribution: null,
    reasons: [
      "TEST_ONLY indexed observations. No real-world value or legal effect.",
    ],
  };
}
