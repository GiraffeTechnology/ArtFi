"use client";

import localFont from "next/font/local";
import Link from "next/link";
import { publicSetting } from "@/lib/public-runtime-config";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const recoveryFont = localFont({
  src: "../fonts/InterVariable.woff2",
  display: "swap",
  weight: "100 900",
  fallback: [],
});

import {
  freshness,
  shortOrderId,
  venueLabel,
  venueLink,
} from "@/lib/market-links";

const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");

import { type MarketAsset } from "@/lib/complete-market-catalog";
import {
  fetchMarketCatalogPage,
  marketCatalogQuery,
} from "@/lib/market-catalog-query";

type MarketProviderHealth = {
  source: string;
  state: "starting" | "healthy" | "degraded" | "stale" | "stopped";
  stale: boolean;
  realtimeConnected: boolean;
  receivedAt: string;
  reportLagSeconds: number;
  reportingStale: boolean;
  available: boolean;
};
export function LiveMarketCatalog() {
  const [assets, setAssets] = useState<readonly MarketAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [providerHealth, setProviderHealth] = useState<MarketProviderHealth>();
  const [providerHealthError, setProviderHealthError] = useState<string>();
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [inputError, setInputError] = useState<string>();
  const [total, setTotal] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const [listingStatus, setListingStatus] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [page, setPage] = useState(1);
  const requestInFlight = useRef<AbortController | null>(null);
  const pageSize = 12;

  const loadCatalog = useCallback(async () => {
    if (requestInFlight.current) return;
    const controller = new AbortController();
    requestInFlight.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);
    setLoading(true);
    try {
      const result = await fetchMarketCatalogPage(
        fetch,
        apiURL,
        { q: query, listingStatus, sort: sortOrder },
        page,
        controller.signal,
      );
      if (requestInFlight.current !== controller || controller.signal.aborted)
        return;
      setAssets(result.data);
      setTotal(result.total);
      setCatalogError(undefined);
    } catch (error) {
      if (
        requestInFlight.current !== controller ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      setAssets([]);
      setTotal(undefined);
      setCatalogError(
        timedOut
          ? "The market catalog page could not be read before the refresh timeout."
          : error instanceof Error
            ? error.message
            : "Live market data is unavailable.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestInFlight.current === controller) {
        requestInFlight.current = null;
        setLoading(false);
      }
    }
  }, [page, query, listingStatus, sortOrder, attempt]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadCatalog(), 0);
    const interval = window.setInterval(() => void loadCatalog(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      const pending = requestInFlight.current;
      requestInFlight.current = null;
      pending?.abort();
    };
  }, [loadCatalog]);

  useEffect(() => {
    let pending: AbortController | undefined;
    let disposed = false;
    async function refreshHealth() {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(
          `${apiURL}/v1/market/health?source=opensea`,
          {
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (!response.ok)
          throw new Error(
            `Provider health unavailable (HTTP ${response.status}).`,
          );
        const body = (await response.json()) as MarketProviderHealth;
        if (
          body.source !== "opensea" ||
          !["starting", "healthy", "degraded", "stale", "stopped"].includes(
            body.state,
          ) ||
          [
            body.available,
            body.stale,
            body.reportingStale,
            body.realtimeConnected,
          ].some((value) => typeof value !== "boolean") ||
          !Number.isSafeInteger(body.reportLagSeconds) ||
          body.reportLagSeconds < 0 ||
          !Number.isFinite(Date.parse(body.receivedAt)) ||
          (body.available &&
            (body.stale ||
              body.reportingStale ||
              !body.realtimeConnected ||
              body.state !== "healthy"))
        ) {
          throw new Error("The provider health response is invalid.");
        }
        if (disposed || controller.signal.aborted) return;
        setProviderHealth(body);
        setProviderHealthError(undefined);
      } catch (error) {
        if (disposed) return;
        setProviderHealth(undefined);
        setProviderHealthError(
          error instanceof Error
            ? error.message
            : "Provider health unavailable.",
        );
      } finally {
        window.clearTimeout(timeout);
        if (pending === controller) pending = undefined;
      }
    }
    void refreshHealth();
    const interval = window.setInterval(() => void refreshHealth(), 15_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      pending?.abort();
    };
  }, []);

  const lastObserved = useMemo(() => {
    const values = assets
      .map((asset) => Date.parse(asset.latestEventTimestamp))
      .filter(Number.isFinite);
    return values.length > 0
      ? new Date(Math.max(...values)).toISOString()
      : undefined;
  }, [assets]);

  const totalPages = Math.max(1, Math.ceil((total ?? 0) / pageSize));
  const currentPage = page;
  const visibleAssets = assets;
  function clearCurrentPage() {
    setAssets([]);
    setTotal(undefined);
    setCatalogError(undefined);
    setLoading(true);
  }
  function selectPage(next: number) {
    clearCurrentPage();
    setPage(next);
  }

  return (
    <section className="live-market" aria-live="polite">
      <form
        className="market-filters"
        aria-label="Search and filter mirrored NFTs"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            marketCatalogQuery(
              { q: draftQuery, listingStatus, sort: sortOrder },
              1,
            );
          } catch {
            setInputError(
              "Use at most 100 search characters without control characters.",
            );
            return;
          }
          setInputError(undefined);
          clearCurrentPage();
          setQuery(draftQuery.trim());
          setPage(1);
          setAttempt((value) => value + 1);
        }}
      >
        <label>
          Search
          <input
            type="search"
            placeholder="Collection, contract, token or chain"
            value={draftQuery}
            maxLength={200}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          Listing status
          <select
            data-translate-options="static"
            value={listingStatus}
            onChange={(event) => {
              clearCurrentPage();
              setListingStatus(event.currentTarget.value);
              setPage(1);
            }}
          >
            <option value="all">All records</option>
            <option value="active">Active listings</option>
            <option value="inactive">Not actively listed</option>
          </select>
        </label>
        <label>
          Sort
          <select
            data-translate-options="static"
            value={sortOrder}
            onChange={(event) => {
              clearCurrentPage();
              setSortOrder(event.currentTarget.value);
              setPage(1);
            }}
          >
            <option value="newest">Newest observed</option>
            <option value="oldest">Oldest observed</option>
            <option value="token">Chain, contract and token</option>
          </select>
        </label>
        <button type="submit" disabled={loading}>
          Search catalog
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setDraftQuery("");
            setQuery("");
            setListingStatus("all");
            setSortOrder("newest");
            setInputError(undefined);
            clearCurrentPage();
            setPage(1);
            setAttempt((value) => value + 1);
          }}
        >
          Clear search and filters
        </button>
      </form>
      {inputError && <p role="alert">{inputError}</p>}
      {query && <p data-no-translate>Applied search: {query}</p>}

      <div className="filter-bar" aria-label="Live market status">
        <span>OpenSea information mirror</span>
        <span>
          {loading
            ? "Loading…"
            : catalogError
              ? "Market data unavailable"
              : `${visibleAssets.length} shown · ${total ?? 0} matched across the catalog`}
        </span>
        <span>
          {lastObserved
            ? `Latest observation on this page: ${formatObserved(lastObserved)}`
            : catalogError
              ? "Awaiting a successful refresh"
              : "Awaiting source events"}
        </span>
      </div>

      <div
        className="market-provider-health"
        role="status"
        aria-label="Marketplace provider health"
      >
        <strong>
          {providerHealth?.available
            ? `Provider live · report ${providerHealth.reportLagSeconds}s old`
            : providerHealth?.reportingStale
              ? "Provider report stale"
              : providerHealth?.stale
                ? "Provider data stale"
                : providerHealth
                  ? `Provider ${providerHealth.state}`
                  : "Provider status unavailable"}
        </strong>
        {!providerHealth?.available && (
          <p>
            {providerHealthError ||
              "No current healthy provider report is available."}{" "}
            Mirrored records remain observations and may be out of date.
          </p>
        )}
      </div>
      <p>
        Search, status and sorting are applied across the mirrored catalog
        before pagination. Each page is an observation; source records can
        change between reads. This is not an atomic inventory snapshot.
      </p>

      {catalogError ? (
        <div
          className={`market-runtime-state ${recoveryFont.className}`}
          role="alert"
        >
          <strong>Live mirror unavailable</strong>
          <span>{catalogError} No fixture is shown as live data.</span>
          <span>
            Previous results are hidden until the market refresh succeeds.
          </span>
          <button
            type="button"
            className="wallet-button"
            disabled={loading}
            onClick={() => void loadCatalog()}
          >
            {loading ? "Retrying…" : "Retry market data"}
          </button>
        </div>
      ) : null}
      {!loading && !catalogError && assets.length === 0 ? (
        <div className="market-runtime-state">
          <strong>
            {query || listingStatus !== "all"
              ? "No records match these filters"
              : "No OpenSea assets observed yet"}
          </strong>
          <span>
            The page will populate only from attributed runtime events.
          </span>
        </div>
      ) : null}

      <div className="market-mirror-grid">
        {visibleAssets.map((asset) => {
          const key = `${asset.chain}:${asset.contractAddress}:${asset.tokenId}`;
          const active =
            asset.orderStatus === "active" && Boolean(asset.orderHash);
          const orderId = shortOrderId(asset.orderHash);
          // The link is the one the source reported, re-validated here; never one ArtFi assembles.
          const link = venueLink(asset.source, asset.marketplaceUrl);
          return (
            <article className="market-mirror-card" key={key}>
              <div className="market-mirror-card__artwork market-placeholder">
                <span>No public preview</span>
              </div>
              <div className="market-mirror-card__body">
                <span className="mirror-badge">OpenSea information mirror</span>
                <h3>{asset.collectionSlug || "Unlabelled collection"}</h3>
                <p>
                  Token #{asset.tokenId} · {shortAddress(asset.contractAddress)}
                </p>
                <dl>
                  <div>
                    <dt>Source</dt>
                    <dd>{venueLabel(asset.source)}</dd>
                  </div>
                  <div>
                    <dt>Chain</dt>
                    <dd data-no-translate>{asset.chain}</dd>
                  </div>
                  <div>
                    <dt>Order</dt>
                    <dd>
                      {active ? "Active listing" : asset.orderStatus || "None"}
                    </dd>
                  </div>
                  {orderId ? (
                    <div>
                      <dt>Order ID</dt>
                      <dd data-no-translate>{orderId}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Observed</dt>
                    <dd>{formatObserved(asset.latestEventTimestamp)}</dd>
                  </div>
                  <div>
                    <dt>Freshness</dt>
                    <dd>{freshness(asset.latestEventTimestamp)}</dd>
                  </div>
                  {asset.price ? (
                    <div>
                      <dt>Raw price</dt>
                      <dd>
                        {asset.price} {asset.paymentSymbol || "units"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <details className="market-source-reference">
                  <summary>Full asset identity</summary>
                  <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                    Chain: {asset.chain}
                  </p>
                  <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                    Contract: {asset.contractAddress}
                  </p>
                  <p data-no-translate style={{ overflowWrap: "anywhere" }}>
                    Token ID: {asset.tokenId}
                  </p>
                </details>
                {link ? (
                  <details className="market-source-reference">
                    <summary>Source reference</summary>
                    <p data-no-translate>{link}</p>
                  </details>
                ) : (
                  <p className="market-gate">
                    No venue link was attributed to this record. ArtFi does not
                    construct one.
                  </p>
                )}
                <p className="market-gate">
                  Observed record only. This panel does not submit an order. Use
                  the native NFT marketplace for configured collections.
                </p>
                <Link href="/nft">Open native NFT trading</Link>
              </div>
            </article>
          );
        })}
      </div>

      {(total !== undefined && total > pageSize) || page > 1 ? (
        <nav className="market-pagination" aria-label="Market result pages">
          <button
            type="button"
            disabled={loading || currentPage === 1}
            onClick={() => selectPage(Math.max(1, page - 1))}
          >
            Previous
          </button>
          <span>
            {total === undefined
              ? `Requested page ${page}`
              : `Page ${currentPage} of ${totalPages}`}
          </span>
          <button
            type="button"
            disabled={
              loading ||
              Boolean(catalogError) ||
              total === undefined ||
              currentPage >= totalPages ||
              page >= 1000000
            }
            onClick={() => selectPage(page + 1)}
          >
            Next
          </button>
          <button
            type="button"
            disabled={loading || page === 1}
            onClick={() => selectPage(1)}
          >
            First page
          </button>
          <button
            type="button"
            disabled={
              loading ||
              Boolean(catalogError) ||
              total === undefined ||
              page >= totalPages ||
              totalPages > 1000000
            }
            onClick={() => selectPage(totalPages)}
          >
            Last page
          </button>
          {totalPages > 1000000 && (
            <p>
              Narrow the search to reach results beyond the bounded page range.
            </p>
          )}
        </nav>
      ) : null}
    </section>
  );
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatObserved(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
