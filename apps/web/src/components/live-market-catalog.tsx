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

import {
  readCompleteMarketCatalog,
  type MarketAsset,
} from "@/lib/complete-market-catalog";

export function LiveMarketCatalog() {
  const [assets, setAssets] = useState<readonly MarketAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [query, setQuery] = useState("");
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
      const collected = await readCompleteMarketCatalog(
        fetch,
        apiURL,
        controller.signal,
      );
      if (requestInFlight.current !== controller || controller.signal.aborted)
        return;
      setAssets(collected);
      setCatalogError(undefined);
    } catch (error) {
      if (
        requestInFlight.current !== controller ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      setAssets([]);
      setCatalogError(
        timedOut
          ? "The market catalog refresh timed out before the complete scan finished."
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
  }, []);

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

  const lastObserved = useMemo(() => {
    const values = assets
      .map((asset) => Date.parse(asset.latestEventTimestamp))
      .filter(Number.isFinite);
    return values.length > 0
      ? new Date(Math.max(...values)).toISOString()
      : undefined;
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = assets.filter((asset) => {
      const matchesQuery =
        normalizedQuery === "" ||
        [
          asset.collectionSlug,
          asset.contractAddress,
          asset.tokenId,
          asset.chain,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery));
      const active = asset.orderStatus === "active" && Boolean(asset.orderHash);
      const matchesStatus =
        listingStatus === "all" ||
        (listingStatus === "active" ? active : !active);
      return matchesQuery && matchesStatus;
    });
    return result.toSorted((left, right) => {
      if (sortOrder === "oldest") {
        return (
          Date.parse(left.latestEventTimestamp) -
          Date.parse(right.latestEventTimestamp)
        );
      }
      if (sortOrder === "token") {
        const contract = left.contractAddress.localeCompare(
          right.contractAddress,
        );
        if (contract !== 0) return contract;
        return BigInt(left.tokenId) < BigInt(right.tokenId) ? -1 : 1;
      }
      return (
        Date.parse(right.latestEventTimestamp) -
        Date.parse(left.latestEventTimestamp)
      );
    });
  }, [assets, listingStatus, query, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleAssets = filteredAssets.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  return (
    <section className="live-market" aria-live="polite">
      <form
        className="market-filters"
        aria-label="Search and filter mirrored NFTs"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Search
          <input
            type="search"
            placeholder="Collection, contract, token or chain"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Listing status
          <select
            value={listingStatus}
            onChange={(event) => {
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
            value={sortOrder}
            onChange={(event) => {
              setSortOrder(event.currentTarget.value);
              setPage(1);
            }}
          >
            <option value="newest">Newest observed</option>
            <option value="oldest">Oldest observed</option>
            <option value="token">Contract and token</option>
          </select>
        </label>
      </form>

      <div className="filter-bar" aria-label="Live market status">
        <span>OpenSea information mirror</span>
        <span>
          {loading
            ? "Loading…"
            : catalogError
              ? "Market data unavailable"
              : `${visibleAssets.length} shown · ${filteredAssets.length} matched · ${assets.length} total`}
        </span>
        <span>
          {lastObserved
            ? `Observed ${formatObserved(lastObserved)}`
            : catalogError
              ? "Awaiting a successful refresh"
              : "Awaiting source events"}
        </span>
      </div>

      <p>
        Search and filters cover this completed observation scan. Source records
        may change between page reads; this is not an atomic inventory snapshot.
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
          <strong>No OpenSea assets observed yet</strong>
          <span>
            The page will populate only from attributed runtime events.
          </span>
        </div>
      ) : null}
      {!loading &&
      !catalogError &&
      assets.length > 0 &&
      filteredAssets.length === 0 ? (
        <div className="market-runtime-state">
          <strong>No records match these filters</strong>
          <span>
            Change the search text or listing status. Runtime data remains
            unchanged.
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

      {filteredAssets.length > pageSize ? (
        <nav className="market-pagination" aria-label="Market result pages">
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            Previous
          </button>
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage === totalPages}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
          >
            Next
          </button>
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
