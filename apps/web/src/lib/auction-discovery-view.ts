import type { DiscoveredAuction } from "./auction-discovery-pages";

export type AuctionDiscoveryOrder = "newest" | "oldest" | "ends-first";

/** Presentation order within one verified page only. Source rows, cursors and
 * financial state are unchanged; this never sorts across unobserved windows. */
export function orderAuctionDiscoveryRows(
  rows: readonly DiscoveredAuction[],
  order: AuctionDiscoveryOrder,
): readonly DiscoveredAuction[] {
  if (!["newest", "oldest", "ends-first"].includes(order))
    throw new Error("Unsupported auction display order.");
  const chronology = (a: DiscoveredAuction, b: DiscoveredAuction) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1;
  return Object.freeze(
    [...rows].sort((a, b) => {
      if (order === "ends-first" && a.endsAt !== b.endsAt)
        return a.endsAt < b.endsAt ? -1 : 1;
      return order === "oldest" ? chronology(a, b) : chronology(b, a);
    }),
  );
}
