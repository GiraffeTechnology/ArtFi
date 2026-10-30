import type {
  AuctionHistoryCursor,
  AuctionHistoryPage,
} from "./auction-history-pages";
import {
  createPublicBlockHistoryPager,
  type PublicBlockHistoryPagerState,
} from "./public-block-history-pager";

export type AuctionHistoryPagerState =
  PublicBlockHistoryPagerState<AuctionHistoryPage>;

// Retain the original per-auction API; discovery uses its own cursor/page types.
export function createAuctionHistoryPager(
  read: (
    cursor: AuctionHistoryCursor | null,
    signal: AbortSignal,
  ) => Promise<AuctionHistoryPage>,
  now: () => number = Date.now,
) {
  return createPublicBlockHistoryPager<
    AuctionHistoryCursor,
    AuctionHistoryPage
  >(read, now);
}
