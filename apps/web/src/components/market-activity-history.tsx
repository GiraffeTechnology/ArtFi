"use client";

import { publicSetting } from "@/lib/public-runtime-config";

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

/** Read-only source history. Native order operations are a separate application workflow. */

const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");
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
        OpenSea, each with its source, time, freshness and reported source
        reference. This history panel is read-only and does not submit orders.
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
                    <details className="market-source-reference">
                      <summary>Source reference</summary>
                      <p data-no-translate>{link}</p>
                    </details>
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
