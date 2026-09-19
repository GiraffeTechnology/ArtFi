"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  freshness,
  shortOrderId,
  venueLabel,
  venueLink,
} from "@/lib/market-links";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type MarketAsset = {
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionSlug?: string;
  latestEventType: string;
  latestEventTimestamp: string;
  orderHash?: string;
  orderStatus?: string;
  price?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
};

type MarketCatalogResponse = {
  data: MarketAsset[];
  total: number;
  runtime: true;
};

export function LiveMarketCatalog() {
  const [assets, setAssets] = useState<MarketAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [query, setQuery] = useState("");
  const [listingStatus, setListingStatus] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [page, setPage] = useState(1);
  const pageSize = 12;

  const loadCatalog = useCallback(async () => {
    try {
      const collected: MarketAsset[] = [];
      let sourcePage = 1;
      let total = 0;
      do {
        const response = await fetch(
          `${apiURL}/v1/market/assets?source=opensea&page=${sourcePage}&pageSize=100`,
          { cache: "no-store" },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as MarketCatalogResponse;
        if (body.runtime !== true || !Array.isArray(body.data)) {
          throw new Error("The market catalog response is not runtime data.");
        }
        collected.push(...body.data);
        total = body.total;
        sourcePage += 1;
      } while (collected.length < total && sourcePage <= 100);
      setAssets(collected);
      setCatalogError(undefined);
    } catch (error) {
      setCatalogError(
        error instanceof Error
          ? error.message
          : "Live market data is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadCatalog(), 0);
    const interval = window.setInterval(() => void loadCatalog(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
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
            : `${visibleAssets.length} shown · ${filteredAssets.length} matched · ${assets.length} total`}
        </span>
        <span>
          {lastObserved
            ? `Observed ${formatObserved(lastObserved)}`
            : "Awaiting source events"}
        </span>
      </div>

      {catalogError ? (
        <div className="market-runtime-state" role="alert">
          <strong>Live mirror unavailable</strong>
          <span>{catalogError} No fixture is shown as live data.</span>
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
                  <a
                    className="text-link market-venue-link"
                    href={link}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                  >
                    Open this record on {venueLabel(asset.source)}
                  </a>
                ) : (
                  <p className="market-gate">
                    No venue link was attributed to this record. ArtFi does not
                    construct one.
                  </p>
                )}
                <p className="market-gate">
                  Mirrored record. Execution completes on{" "}
                  {venueLabel(asset.source)}; ArtFi creates, signs, matches,
                  custodies, fulfils and settles nothing on its behalf.
                </p>
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

async function responseError(response: Response) {
  const fallback = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as { detail?: string };
    return new Error(body.detail || fallback);
  } catch {
    return new Error(fallback);
  }
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatObserved(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
