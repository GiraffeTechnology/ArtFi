/**
 * Walking the mirrored activity history — Issue #110's external-marketplace baseline, detailed by
 * `docs/PRD.md` §4.8 XM.2–XM.3, and §3.2's delivery standard.
 *
 * `/v1/market/activity` served a `limit` alone, capped at 100, so the most any reader could see was
 * the hundred most recent events — and no screen reached it at all. The endpoint now issues a keyset
 * cursor; this is the half that turns a sequence of pages into a history a person can read.
 *
 * Three rules shape it, and each exists because its absence would mislead rather than merely
 * inconvenience:
 *
 *   - **The end is stated, not inferred.** A response without a `nextCursor` is the end of the
 *     history. A short page is not: the server may return fewer rows than asked for and still have
 *     more, so guessing from page length would tell a reader the history stopped when it had not.
 *   - **An event is never shown twice.** Pages are appended by event id, so a replayed cursor or an
 *     overlapping page cannot make one event look like two, which in a trading feed reads as two
 *     trades.
 *   - **A cursor that does not advance ends the walk.** A server that returned the same position
 *     forever would otherwise spin the client against it indefinitely.
 */

export type MarketActivityEvent = {
  eventId: string;
  source: string;
  eventType: string;
  eventFamily: string;
  chain: string;
  eventTimestamp: string;
  contractAddress?: string;
  tokenId?: string;
  collectionSlug?: string;
  orderHash?: string;
  price?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
};

export type MarketActivityPage = {
  data: MarketActivityEvent[];
  nextCursor?: string;
};

export type MarketActivityWalk = {
  /** Every event seen so far, in the order the history served them. */
  events: MarketActivityEvent[];
  /** The position to ask for next, or `undefined` once the history has ended. */
  cursor?: string;
  /** True once no further page can be asked for. */
  finished: boolean;
};

export const emptyMarketActivityWalk: MarketActivityWalk = {
  events: [],
  cursor: undefined,
  finished: false,
};

/**
 * Folds one page into the walk.
 *
 * `usedCursor` is the position this page was asked for, which is what makes a non-advancing server
 * detectable: a `nextCursor` equal to the one just spent names the same place again.
 */
export function appendMarketActivityPage(
  walk: MarketActivityWalk,
  page: MarketActivityPage,
  usedCursor?: string,
): MarketActivityWalk {
  const seen = new Set(walk.events.map((event) => event.eventId));
  const events = [...walk.events];
  for (const event of page.data) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    events.push(event);
  }

  const next = page.nextCursor?.trim();
  if (!next || next === usedCursor) {
    return { events, cursor: undefined, finished: true };
  }
  return { events, cursor: next, finished: false };
}

/** The query string for the next request in a walk. */
export function marketActivityQuery(
  source: string,
  limit: number,
  cursor?: string,
): string {
  const parameters = new URLSearchParams({ source, limit: String(limit) });
  if (cursor) parameters.set("cursor", cursor);
  return parameters.toString();
}

/**
 * What an event says it is, in words rather than the provider's identifier.
 *
 * Unknown types are shown as they arrived rather than mapped to a friendly guess: a mirror that
 * starts carrying a new event type should show that type, not be quietly relabelled as something
 * ArtFi already understands.
 */
export function activityLabel(eventType: string): string {
  const known: Record<string, string> = {
    item_listed: "Listed",
    item_sold: "Sold",
    item_transferred: "Transferred",
    item_received_offer: "Offer received",
    item_received_bid: "Bid received",
    item_cancelled: "Cancelled",
    item_metadata_updated: "Metadata updated",
  };
  return known[eventType] ?? eventType;
}
