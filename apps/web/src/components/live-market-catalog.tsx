"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";

import { externalMarketChain } from "@/lib/wagmi";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const tradeEnabled = process.env.NEXT_PUBLIC_EXTERNAL_TRADE_ENABLED === "true";

type MarketAsset = {
  source: string;
  chain: string;
  contractAddress: Address;
  tokenId: string;
  collectionSlug?: string;
  latestEventType: string;
  latestEventTimestamp: string;
  orderHash?: Hex;
  orderStatus?: string;
  price?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
};

type MarketCatalogResponse = {
  data: MarketAsset[];
  total: number;
  page: number;
  pageSize: number;
  runtime: true;
};

type MarketTransaction = {
  chain: string;
  to: Address;
  data: Hex;
  value: string;
  valueHex?: Hex;
};

type MarketIntent = {
  intentId: string;
  source: string;
  action: "fulfill-listing";
  chain: string;
  orderHash: Hex;
  contractAddress: Address;
  tokenId: string;
  walletAddress: Address;
  status:
    | "initiated"
    | "awaiting-wallet"
    | "submitted"
    | "accepted"
    | "rejected"
    | "pending"
    | "confirmed"
    | "failed"
    | "cancelled";
  marketplaceUrl: string;
  transactions: MarketTransaction[];
  transactionHash?: Hex;
  externalTransactionHash?: Hex;
  failureCode?: string;
};

type IntentView = {
  asset: MarketAsset;
  intent: MarketIntent;
};

export function LiveMarketCatalog() {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const [assets, setAssets] = useState<MarketAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [intentView, setIntentView] = useState<IntentView>();
  const [intentError, setIntentError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [listingStatus, setListingStatus] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [page, setPage] = useState(1);
  const idempotencyKeys = useRef(new Map<string, string>());
  const pageSize = 12;

  const loadCatalog = useCallback(async () => {
    try {
      const collected: MarketAsset[] = [];
      let page = 1;
      let total = 0;
      do {
        const response = await fetch(
          `${apiURL}/v1/market/assets?source=opensea&page=${page}&pageSize=100`,
          { cache: "no-store" },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as MarketCatalogResponse;
        if (body.runtime !== true || !Array.isArray(body.data)) {
          throw new Error("The market catalog response is not runtime data.");
        }
        collected.push(...body.data);
        total = body.total;
        page += 1;
      } while (collected.length < total && page <= 100);
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

  useEffect(() => {
    if (!intentView || isTerminal(intentView.intent.status)) return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(
          `${apiURL}/v1/market/intents/${intentView.intent.intentId}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const intent = (await response.json()) as MarketIntent;
        setIntentView((current) =>
          current ? { ...current, intent } : current,
        );
        if (isTerminal(intent.status)) void loadCatalog();
      } catch {
        // The last authoritative state remains visible while polling recovers.
      }
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [intentView, loadCatalog]);

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

  async function prepareTrade(asset: MarketAsset) {
    if (!address || !asset.orderHash) return;
    setBusy(true);
    setIntentError(undefined);
    try {
      const keyName = `${address.toLowerCase()}:${asset.orderHash.toLowerCase()}`;
      const idempotencyKey =
        idempotencyKeys.current.get(keyName) ?? crypto.randomUUID();
      idempotencyKeys.current.set(keyName, idempotencyKey);
      const intent = await fetchJSON<MarketIntent>("/v1/market/intents", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          source: asset.source,
          action: "fulfill-listing",
          chain: asset.chain,
          orderHash: asset.orderHash,
          walletAddress: address,
        }),
      });
      if (
        intent.walletAddress.toLowerCase() !== address.toLowerCase() ||
        intent.orderHash.toLowerCase() !== asset.orderHash.toLowerCase() ||
        intent.transactions.length !== 1
      ) {
        throw new Error(
          "The external transaction plan failed local verification.",
        );
      }
      setIntentView({ asset, intent });
    } catch (error) {
      setIntentError(
        error instanceof Error
          ? error.message
          : "The external transaction plan could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmTrade() {
    if (!intentView || !address) return;
    const transaction = intentView.intent.transactions[0];
    if (!transaction || transaction.chain !== "ethereum") {
      setIntentError(
        "Only a reviewed same-chain Ethereum plan can be submitted.",
      );
      return;
    }
    setBusy(true);
    setIntentError(undefined);
    try {
      await switchChainAsync({ chainId: externalMarketChain.id });
      const hash = await sendTransactionAsync({
        account: address,
        chainId: externalMarketChain.id,
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.value),
      });
      const intent = await fetchJSON<MarketIntent>(
        `/v1/market/intents/${intentView.intent.intentId}/submission`,
        {
          method: "POST",
          body: JSON.stringify({ transactionHash: hash }),
        },
      );
      setIntentView((current) => (current ? { ...current, intent } : current));
    } catch (error) {
      setIntentError(
        error instanceof Error
          ? error.message
          : "The external wallet did not submit the transaction.",
      );
    } finally {
      setBusy(false);
    }
  }

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
        <span>OpenSea runtime records</span>
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
          return (
            <article className="market-mirror-card" key={key}>
              <div className="market-mirror-card__artwork market-placeholder">
                <span>No public preview</span>
              </div>
              <div className="market-mirror-card__body">
                <span className="mirror-badge">OpenSea runtime mirror</span>
                <h3>{asset.collectionSlug || "Unlabelled collection"}</h3>
                <p>
                  Token #{asset.tokenId} · {shortAddress(asset.contractAddress)}
                </p>
                <dl>
                  <div>
                    <dt>Order</dt>
                    <dd>
                      {active ? "Active listing" : asset.orderStatus || "None"}
                    </dd>
                  </div>
                  <div>
                    <dt>Observed</dt>
                    <dd>{formatObserved(asset.latestEventTimestamp)}</dd>
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
                <div className="market-actions">
                  {asset.marketplaceUrl ? (
                    <a
                      href={asset.marketplaceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Verify on OpenSea ↗
                    </a>
                  ) : null}
                  {active && tradeEnabled ? (
                    <button
                      type="button"
                      disabled={!isConnected || busy}
                      onClick={() => void prepareTrade(asset)}
                    >
                      {isConnected
                        ? "Prepare external purchase"
                        : "Connect wallet to trade"}
                    </button>
                  ) : active ? (
                    <span className="market-gate">
                      External execution gated
                    </span>
                  ) : null}
                </div>
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

      {intentView ? (
        <aside className="market-intent-panel">
          <p className="eyebrow">External transaction review</p>
          <h2>OpenSea remains the executing venue.</h2>
          <dl>
            <div>
              <dt>Asset</dt>
              <dd>Token #{intentView.intent.tokenId}</dd>
            </div>
            <div>
              <dt>Order</dt>
              <dd>{shortHash(intentView.intent.orderHash)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{intentView.intent.status}</dd>
            </div>
            <div>
              <dt>Wallet value</dt>
              <dd>{intentView.intent.transactions[0]?.value ?? "—"} wei</dd>
            </div>
          </dl>
          <p>
            ArtFi does not sign, match, custody, fulfill, or settle this order.
            Your wallet will show the final Ethereum transaction before
            submission.
          </p>
          {intentView.intent.status === "awaiting-wallet" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void confirmTrade()}
            >
              Confirm in external wallet
            </button>
          ) : null}
          {intentView.intent.marketplaceUrl ? (
            <a
              href={intentView.intent.marketplaceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Inspect authoritative listing ↗
            </a>
          ) : null}
        </aside>
      ) : null}
      {intentError ? <p className="dao-error">{intentError}</p> : null}
    </section>
  );
}

async function fetchJSON<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(apiURL + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
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

function shortHash(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatObserved(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

function isTerminal(status: MarketIntent["status"]) {
  return ["confirmed", "failed", "cancelled", "rejected"].includes(status);
}
