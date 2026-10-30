"use client";

import { publicSetting } from "@/lib/public-runtime-config";

import { useEffect, useState, useSyncExternalStore } from "react";

import { activityLabel } from "@/lib/market-activity";
import {
  createMarketHistorySession,
  readMarketHistoryPage,
} from "@/lib/market-activity-session";
import {
  freshness,
  shortOrderId,
  venueLabel,
  venueLink,
} from "@/lib/market-links";

/** Read-only source history. Native order operations are a separate application workflow. */

const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");

export function MarketActivityHistory() {
  const [session] = useState(() =>
    createMarketHistorySession((query, signal) =>
      readMarketHistoryPage(apiURL, query, signal),
    ),
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const { events, finished, loading, error, started, contract } = snapshot;
  const [contractInput, setContractInput] = useState("");
  const [filterError, setFilterError] = useState("");
  useEffect(() => {
    session.activate();
    return () => session.deactivate();
  }, [session]);
  function applyFilter(value: string) {
    try {
      session.applyFilter(value);
      setContractInput(session.getSnapshot().contract);
      setFilterError("");
    } catch (caught) {
      setFilterError(
        caught instanceof Error
          ? caught.message
          : "The contract filter is invalid.",
      );
    }
  }

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

      <form
        className="market-filters"
        aria-label="Filter market activity"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilter(contractInput);
        }}
      >
        <label>
          Contract address
          <input
            data-no-translate
            type="text"
            value={contractInput}
            maxLength={42}
            spellCheck={false}
            placeholder="0x… or leave empty for all contracts"
            onChange={(event) => setContractInput(event.currentTarget.value)}
          />
        </label>
        <button type="submit" className="secondary">
          Apply contract filter
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => applyFilter("")}
        >
          Clear contract filter
        </button>
      </form>
      <p>
        Active contract:{" "}
        {contract ? <span data-no-translate>{contract}</span> : "All contracts"}{" "}
        · Source: <span data-no-translate>OpenSea</span>
      </p>
      <p>
        Filters are applied by the mirror API across the paginated history.
        Prices remain source-reported amounts; this history does not establish
        settlement finality.
      </p>
      {filterError ? (
        <p className="market-runtime-state" role="alert">
          {filterError}
        </p>
      ) : null}

      {error && (
        <p
          className="market-runtime-state"
          role="alert"
          data-testid="activity-error"
        >
          {error}
        </p>
      )}

      {!error && started && finished && events.length === 0 && (
        <p className="market-runtime-state" data-testid="activity-empty">
          The mirror returned no events for this source and contract filter.
          This is an answer from the mirror, not an assumption made here.
        </p>
      )}

      {!error && started && !loading && !finished && events.length === 0 ? (
        <p className="market-runtime-state">
          This page contained no events. The mirror supplied an older page; the
          history is not known to be empty.
        </p>
      ) : null}

      {events.length > 0 && (
        <ol className="market-mirror-grid" data-testid="activity-list">
          {events.map((item) => {
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
                      <dt>Contract</dt>
                      <dd data-no-translate>
                        {item.contractAddress || "Not reported"}
                      </dd>
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
        <button
          type="button"
          className="secondary"
          onClick={session.refresh}
          disabled={loading}
        >
          Refresh this history
        </button>
        {!finished && (
          <button
            type="button"
            className="secondary"
            onClick={() => void session.loadMore()}
            disabled={loading}
            data-testid="activity-load-more"
          >
            {loading ? "Reading the mirror…" : "Load older activity"}
          </button>
        )}
      </nav>

      {finished && events.length > 0 && (
        <p className="market-gate" data-testid="activity-end">
          The history ends here. The mirror said so — it was not inferred from a
          short page.
        </p>
      )}
    </section>
  );
}
