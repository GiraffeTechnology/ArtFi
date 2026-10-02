"use client";

import { useCallback, useEffect, useState } from "react";

import {
  activityLabel,
  appendMarketActivityPage,
  emptyMarketActivityWalk,
  marketActivityQuery,
  type MarketActivityPage,
  type MarketActivityWalk,
} from "@/lib/market-activity";
import {
  freshness,
  shortOrderId,
  venueLabel,
  venueLink,
} from "@/lib/market-links";

/**
 * The mirrored activity history — Issue #110's external-marketplace baseline, `PRD.md` §4.8
 * XM.2–XM.4, and §3.2's delivery standard.
 *
 * `/v1/market/activity` existed with no screen reaching it, and served at most the hundred most
 * recent events. Under §3.2 an endpoint no screen reaches is progress, not a handover; this is the
 * screen, and the endpoint now issues a keyset cursor so the whole history can be walked.
 *
 * What it will not do:
 *
 *   - **It never constructs a venue link.** Each row shows the URL the source reported, re-validated
 *     by `venueLink`; an unverifiable one renders as text saying so. Assembling one from a chain and
 *     a token id is a claim about the venue that no observed event supports (XM.5).
 *   - **It never infers an empty history.** The API answers 503 rather than an empty list when the
 *     mirror is unreachable, and this says the mirror is unavailable rather than "no activity" —
 *     which are opposite statements to a reader deciding whether a market is quiet or broken.
 *   - **It never implies execution here.** Every row is read-only and attributed; ArtFi creates,
 *     signs, matches, fulfils and settles none of it.
 */

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const pageSize = 25;

export function MarketActivityHistory() {
  const [walk, setWalk] = useState<MarketActivityWalk>(emptyMarketActivityWalk);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState(false);

  const loadPage = useCallback(async (from: MarketActivityWalk) => {
    setLoading(true);
    try {
      const response = await fetch(
        `${apiURL}/v1/market/activity?${marketActivityQuery("opensea", pageSize, from.cursor)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 503
            ? "The external-market mirror is unavailable, so no history can be shown. This is not the same as no activity."
            : `The external-market mirror answered HTTP ${response.status}.`,
        );
      }
      const body = (await response.json()) as MarketActivityPage;
      if (!Array.isArray(body.data)) {
        throw new Error("The activity response is not runtime data.");
      }
      setWalk(appendMarketActivityPage(from, body, from.cursor));
      setError(undefined);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The mirrored activity could not be read.",
      );
    } finally {
      setLoading(false);
      setStarted(true);
    }
  }, []);

  // Deferred to a task rather than run in the effect body, so the first page's state lands in its
  // own render instead of cascading out of this one.
  useEffect(() => {
    const initial = window.setTimeout(
      () => void loadPage(emptyMarketActivityWalk),
      0,
    );
    return () => window.clearTimeout(initial);
  }, [loadPage]);

  return (
    <section
      className="section-block section-block--compact"
      aria-labelledby="activity-history"
    >
      <p className="approved-eyebrow">External market mirror</p>
      <h2 id="activity-history">
        Every mirrored event, newest first and walkable to the end.
      </h2>
      <p>
        Listings, offers, sales, transfers and cancellations observed on
        OpenSea, each with its source, time, freshness and the link the venue
        itself reported. ArtFi creates, signs, matches, fulfils and settles none
        of it.
      </p>

      {error && (
        <p
          className="market-runtime-state"
          role="alert"
          data-testid="activity-error"
        >
          {error}
        </p>
      )}

      {!error && started && walk.events.length === 0 && (
        <p className="market-runtime-state" data-testid="activity-empty">
          The mirror is reachable and has observed no activity yet. That is an
          answer from the mirror, not an assumption made here.
        </p>
      )}

      {walk.events.length > 0 && (
        <ol className="market-mirror-grid" data-testid="activity-list">
          {walk.events.map((item) => {
            const link = venueLink(item.source, item.marketplaceUrl);
            const order = shortOrderId(item.orderHash);
            return (
              <li key={item.eventId} className="market-mirror-card">
                <div className="market-mirror-card__body">
                  <span className="mirror-badge">
                    {venueLabel(item.source)} information mirror
                  </span>
                  <h3>{activityLabel(item.eventType)}</h3>
                  <p>{freshness(item.eventTimestamp)}</p>
                  <dl>
                    <div>
                      <dt>Chain</dt>
                      <dd>{item.chain}</dd>
                    </div>
                    <div>
                      <dt>Collection</dt>
                      <dd>{item.collectionSlug || "Not reported"}</dd>
                    </div>
                    <div>
                      <dt>Token</dt>
                      <dd>{item.tokenId || "Not reported"}</dd>
                    </div>
                    <div>
                      <dt>Order</dt>
                      <dd>{order ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt>Price</dt>
                      <dd>
                        {item.price
                          ? `${item.price} ${item.paymentSymbol ?? ""}`.trim()
                          : "Not reported"}
                      </dd>
                    </div>
                    <div>
                      <dt>Observed</dt>
                      <dd>{item.eventTimestamp}</dd>
                    </div>
                  </dl>
                  {link ? (
                    <a
                      className="text-link market-venue-link"
                      href={link}
                      rel="noopener noreferrer nofollow"
                      target="_blank"
                    >
                      Open this event on {venueLabel(item.source)}
                    </a>
                  ) : (
                    <p className="market-gate">
                      No venue link was attributed to this event. ArtFi does not
                      construct one.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <nav className="market-pagination" aria-label="Activity history pages">
        {!walk.finished && (
          <button
            type="button"
            className="secondary"
            onClick={() => void loadPage(walk)}
            disabled={loading}
            data-testid="activity-load-more"
          >
            {loading ? "Reading the mirror…" : "Load older activity"}
          </button>
        )}
      </nav>

      {walk.finished && walk.events.length > 0 && (
        <p className="market-gate" data-testid="activity-end">
          The history ends here. The mirror said so — it was not inferred from a
          short page.
        </p>
      )}
    </section>
  );
}
