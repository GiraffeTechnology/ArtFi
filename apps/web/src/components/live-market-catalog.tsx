"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { MarketActivityHistory } from "./market-activity-history";
import { CurrentMarketListing } from "./current-market-listing";
import { MarketStreamStatus } from "./market-stream-status";

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
};

type MarketCatalogResponse = {
  schemaVersion: "1";
  data: MarketAsset[];
  total: number;
  page: number;
  pageSize: number;
  source: string;
  runtime: true;
};

type MarketObservation = {
  source: string;
  collectionSlug: string;
  status: "fresh" | "stale" | "unavailable";
  lastSuccessAt?: string;
  completedThrough?: string;
  receivedAt: string;
};

type MarketObservationSnapshot = {
  data: MarketObservation[];
  expiresAt: number;
};

export function LiveMarketCatalog() {
  const [assets, setAssets] = useState<MarketAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [observations, setObservations] = useState<MarketObservationSnapshot>();
  const [nowMs, setNowMs] = useState(0);
  const [query, setQuery] = useState("");
  const [listingStatus, setListingStatus] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [page, setPage] = useState(1);
  const catalogRequest = useRef<AbortController | undefined>(undefined);
  const observationRequest = useRef<AbortController | undefined>(undefined);
  const pageSize = 12;

  const loadCatalog = useCallback(async () => {
    if (catalogRequest.current) return;
    const controller = new AbortController();
    catalogRequest.current = controller;
    setLoading(true);
    try {
      const collected: MarketAsset[] = [];
      const seen = new Set<string>();
      let sourcePage = 1;
      let total = 0;
      do {
        const response = await fetch(
          `${apiURL}/v1/market/assets?source=opensea&page=${sourcePage}&pageSize=100`,
          {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15_000),
            ]),
          },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as MarketCatalogResponse;
        if (
          !body ||
          body.schemaVersion !== "1" ||
          body.runtime !== true ||
          body.source !== "opensea" ||
          body.page !== sourcePage ||
          body.pageSize !== 100 ||
          !Number.isSafeInteger(body.total) ||
          body.total < 0 ||
          !Array.isArray(body.data) ||
          body.data.length > 100 ||
          body.data.some(
            (asset) =>
              !asset ||
              asset.source !== "opensea" ||
              typeof asset.chain !== "string" ||
              !/^[a-z][a-z0-9-]{1,31}$/.test(asset.chain) ||
              typeof asset.contractAddress !== "string" ||
              !/^0x[0-9a-f]{40}$/i.test(asset.contractAddress) ||
              typeof asset.tokenId !== "string" ||
              !/^(0|[1-9][0-9]{0,77})$/.test(asset.tokenId) ||
              BigInt(asset.tokenId) >= 2n ** 256n ||
              typeof asset.latestEventType !== "string" ||
              typeof asset.latestEventTimestamp !== "string" ||
              !Number.isFinite(Date.parse(asset.latestEventTimestamp)) ||
              (asset.collectionSlug !== undefined &&
                typeof asset.collectionSlug !== "string") ||
              (asset.price !== undefined &&
                (typeof asset.price !== "string" ||
                  !/^(0|[1-9][0-9]{0,77})$/.test(asset.price) ||
                  BigInt(asset.price) >= 2n ** 256n)) ||
              (asset.paymentSymbol !== undefined &&
                (typeof asset.paymentSymbol !== "string" ||
                  asset.paymentSymbol.length > 16)) ||
              (asset.orderHash !== undefined &&
                (typeof asset.orderHash !== "string" ||
                  !/^0x[0-9a-f]{64}$/i.test(asset.orderHash))) ||
              (asset.orderStatus !== undefined &&
                !["active", "cancelled", "invalidated", "fulfilled"].includes(
                  asset.orderStatus,
                )),
          )
        ) {
          throw new Error("The market catalog response is not runtime data.");
        }
        for (const asset of body.data) {
          const key = `${asset.chain}:${asset.contractAddress.toLowerCase()}:${asset.tokenId}`;
          if (seen.has(key)) {
            throw new Error("The market catalog contains a duplicate asset.");
          }
          seen.add(key);
        }
        collected.push(...body.data);
        total = body.total;
        if (collected.length < total && body.data.length === 0) {
          throw new Error("The market catalog pagination stopped early.");
        }
        sourcePage += 1;
      } while (collected.length < total && sourcePage <= 100);
      if (collected.length !== total) {
        throw new Error("The market catalog is incomplete.");
      }
      if (!controller.signal.aborted) {
        setAssets(collected);
        setCatalogError(undefined);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setCatalogError(
          error instanceof Error
            ? error.message
            : "Live market data is unavailable.",
        );
    } finally {
      if (catalogRequest.current === controller)
        catalogRequest.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const loadObservations = useCallback(async () => {
    if (observationRequest.current) return;
    const controller = new AbortController();
    observationRequest.current = controller;
    try {
      const response = await fetch(
        `${apiURL}/v1/market/observations?source=opensea`,
        {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        },
      );
      if (!response.ok) throw new Error("MARKET_OBSERVATIONS_UNAVAILABLE");
      const body = await response.json();
      const receivedAt = Date.now();
      if (
        !body ||
        body.schemaVersion !== "1" ||
        body.runtime !== true ||
        body.source !== "opensea" ||
        body.maxAgeSeconds !== 90 ||
        !Number.isFinite(Date.parse(body.asOf)) ||
        Math.abs(receivedAt - Date.parse(body.asOf)) > 15_000 ||
        !Array.isArray(body.data) ||
        body.data.length > 1000
      ) {
        throw new Error("MARKET_OBSERVATIONS_INVALID");
      }
      const seen = new Set<string>();
      for (const item of body.data) {
        if (
          !item ||
          item.source !== "opensea" ||
          typeof item.collectionSlug !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item.collectionSlug) ||
          seen.has(item.collectionSlug) ||
          !["fresh", "stale", "unavailable"].includes(item.status) ||
          !Number.isFinite(Date.parse(item.receivedAt)) ||
          (item.lastSuccessAt !== undefined &&
            !Number.isFinite(Date.parse(item.lastSuccessAt))) ||
          (item.completedThrough !== undefined &&
            !Number.isFinite(Date.parse(item.completedThrough))) ||
          (item.status === "fresh" &&
            (!item.lastSuccessAt || !item.completedThrough))
        ) {
          throw new Error("MARKET_OBSERVATIONS_INVALID");
        }
        seen.add(item.collectionSlug);
      }
      if (!controller.signal.aborted)
        setObservations({ data: body.data, expiresAt: receivedAt + 30_000 });
    } catch {
      // Missing health evidence is unknown, not a successful provider probe.
      if (!controller.signal.aborted) setObservations(undefined);
    } finally {
      if (observationRequest.current === controller)
        observationRequest.current = undefined;
    }
  }, []);

  useEffect(() => {
    const refresh = () => void loadObservations();
    const initial = window.setTimeout(refresh, 0);
    const interval = window.setInterval(refresh, 15_000);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.clearInterval(clock);
      window.removeEventListener("focus", refresh);
      observationRequest.current?.abort();
      observationRequest.current = undefined;
    };
  }, [loadObservations]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadCatalog(), 0);
    const interval = window.setInterval(() => void loadCatalog(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      catalogRequest.current?.abort();
      catalogRequest.current = undefined;
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
    const result = (catalogError ? [] : assets).filter((asset) => {
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
        const chain = left.chain.localeCompare(right.chain);
        if (chain !== 0) return chain;
        const contract = left.contractAddress.localeCompare(
          right.contractAddress,
        );
        if (contract !== 0) return contract;
        return BigInt(left.tokenId) === BigInt(right.tokenId)
          ? 0
          : BigInt(left.tokenId) < BigInt(right.tokenId)
            ? -1
            : 1;
      }
      return (
        Date.parse(right.latestEventTimestamp) -
        Date.parse(left.latestEventTimestamp)
      );
    });
  }, [assets, catalogError, listingStatus, query, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleAssets = filteredAssets.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  return (
    <section className="live-market" aria-live="polite">
      <p>
        Read-only public-market observations retain their provider-reported
        chain identity. A connected Hoodi test wallet does not turn these
        records into testnet assets or grant permission to transact.
      </p>
      <MarketStreamStatus />
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
            <option value="active">Last reported active</option>
            <option value="inactive">Other reported states</option>
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

      <button
        type="button"
        disabled={loading}
        onClick={() => {
          void loadCatalog();
          void loadObservations();
        }}
      >
        {loading ? "Refreshing market records…" : "Refresh market records"}
      </button>

      <div className="filter-bar" aria-label="Live market status">
        <span>OpenSea information mirror</span>
        <span>
          {catalogError
            ? "Source unavailable · no live records displayed"
            : loading
              ? "Loading…"
              : `${visibleAssets.length} shown · ${filteredAssets.length} matched · ${assets.length} total`}
        </span>
        <span>
          {!catalogError && lastObserved
            ? `Latest recorded event ${formatObserved(lastObserved)}`
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
          const observation = observations?.data.find(
            (item) => item.collectionSlug === asset.collectionSlug,
          );
          const historyFresh =
            observation?.status === "fresh" &&
            nowMs > 0 &&
            observations !== undefined &&
            nowMs <= observations.expiresAt &&
            [
              observation.lastSuccessAt,
              observation.completedThrough,
              observation.receivedAt,
            ].every((value) => {
              const age = nowMs - Date.parse(value || "");
              return Number.isFinite(age) && age >= -5000 && age <= 90_000;
            });
          const historyState = !observation
            ? "Unknown"
            : historyFresh
              ? "Recently synchronized"
              : observation.status === "unavailable"
                ? "Provider or synchronization unavailable"
                : "Stale";
          return (
            <article className="market-mirror-card" key={key}>
              <div className="market-mirror-card__artwork market-placeholder">
                <span>No public preview</span>
              </div>
              <div className="market-mirror-card__body">
                <span className="mirror-badge">OpenSea information mirror</span>
                <h3>
                  <Link
                    data-no-translate
                    href={`/market/rwa/token?${new URLSearchParams({ chain: asset.chain, contract: asset.contractAddress, tokenId: asset.tokenId })}`}
                  >
                    {asset.collectionSlug || "Unlabelled collection"}
                  </Link>
                </h3>
                <p>
                  Token #
                  <span data-no-translate>
                    {asset.tokenId} · {shortAddress(asset.contractAddress)}
                  </span>
                </p>
                <dl>
                  <div>
                    <dt>Source chain</dt>
                    <dd data-no-translate>{asset.chain}</dd>
                  </div>
                  <div>
                    <dt>Last reported order</dt>
                    <dd>
                      {active
                        ? "Active listing (not revalidated)"
                        : asset.orderStatus || "Unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt>History synchronization</dt>
                    <dd>{historyState}</dd>
                  </div>
                  {observation?.completedThrough ? (
                    <div>
                      <dt>History checked through</dt>
                      <dd data-no-translate>
                        {formatObserved(observation.completedThrough)}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Observed</dt>
                    <dd data-no-translate>
                      {formatObserved(asset.latestEventTimestamp)}
                    </dd>
                  </div>
                  {asset.price ? (
                    <div>
                      <dt>Raw price</dt>
                      <dd data-no-translate>
                        {asset.price} {asset.paymentSymbol || "units"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <p className="market-gate">
                  Source attributed to OpenSea · no external link or trade
                  action. Recorded history does not confirm that a listing is
                  still available now.
                </p>
                <MarketActivityHistory asset={asset} />
                <CurrentMarketListing asset={asset} />
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
            onClick={() => setPage(Math.max(1, currentPage - 1))}
          >
            Previous
          </button>
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage === totalPages}
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
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
