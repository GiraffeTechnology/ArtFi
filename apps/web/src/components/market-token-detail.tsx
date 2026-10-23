"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CurrentMarketListing } from "./current-market-listing";
import { MarketActivityHistory } from "./market-activity-history";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
type AssetIdentity = {
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
};
type ObservedToken = AssetIdentity & {
  collectionSlug?: string;
  latestEventType: string;
  latestEventTimestamp: string;
};

export function MarketTokenDetail({ asset }: { asset: AssetIdentity }) {
  const [record, setRecord] = useState<ObservedToken>();
  const [state, setState] = useState<
    "loading" | "ready" | "missing" | "unavailable"
  >("loading");
  const { source, chain, contractAddress, tokenId } = asset;
  useEffect(() => {
    const lifetime = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = new URLSearchParams({
          source,
          chain,
          contract: contractAddress,
          tokenId,
          page: "1",
          pageSize: "1",
        });
        const response = await fetch(`${apiURL}/v1/market/assets?${query}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) throw new Error("TOKEN_DETAIL_UNAVAILABLE");
        const body = await response.json();
        if (
          !body ||
          body.schemaVersion !== "1" ||
          body.source !== source ||
          body.runtime !== true ||
          body.page !== 1 ||
          body.pageSize !== 1 ||
          ![0, 1].includes(body.total) ||
          !Array.isArray(body.data) ||
          body.data.length !== body.total
        )
          throw new Error("TOKEN_DETAIL_INVALID");
        const item = body.data[0];
        if (
          item &&
          (item.source !== source ||
            item.chain !== chain ||
            item.contractAddress !== contractAddress ||
            item.tokenId !== tokenId ||
            typeof item.latestEventType !== "string" ||
            !Number.isFinite(Date.parse(item.latestEventTimestamp)) ||
            (item.collectionSlug !== undefined &&
              typeof item.collectionSlug !== "string"))
        )
          throw new Error("TOKEN_DETAIL_MISMATCH");
        if (!lifetime.signal.aborted) {
          setRecord(item);
          setState(item ? "ready" : "missing");
        }
      } catch {
        if (!lifetime.signal.aborted) {
          setRecord(undefined);
          setState("unavailable");
        }
      } finally {
        busy = false;
      }
    };
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      lifetime.abort();
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [source, chain, contractAddress, tokenId]);

  return (
    <main className="page-shell page-main">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/market/rwa">Market mirror</Link>
        <span aria-hidden="true">/</span>
        <span>
          Token #<span data-no-translate>{tokenId}</span>
        </span>
      </nav>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Observed whole-artwork token</p>
        <h1>
          {record?.collectionSlug ? (
            <span data-no-translate>{record.collectionSlug}</span>
          ) : (
            "External-market token"
          )}{" "}
          · #<span data-no-translate>{tokenId}</span>
        </h1>
        <p>
          No fixture artwork, valuation or ownership assertion replaces missing
          runtime data.
        </p>
      </header>
      <dl className="asset-metrics">
        <div>
          <dt>Source</dt>
          <dd data-no-translate>{source}</dd>
        </div>
        <div>
          <dt>Chain</dt>
          <dd data-no-translate>{chain}</dd>
        </div>
        <div>
          <dt>Contract</dt>
          <dd data-no-translate style={{ overflowWrap: "anywhere" }}>
            {contractAddress}
          </dd>
        </div>
        <div>
          <dt>Token ID</dt>
          <dd data-no-translate style={{ overflowWrap: "anywhere" }}>
            {tokenId}
          </dd>
        </div>
      </dl>
      {state === "loading" ? (
        <p role="status">Loading attributed runtime record…</p>
      ) : null}
      {state === "unavailable" ? (
        <p role="alert">
          The catalog record is unavailable. No status is inferred from that
          source; listing and history below are read independently.
        </p>
      ) : null}
      {state === "missing" ? (
        <p>
          No mirrored record for this exact token yet. This does not prove the
          NFT does not exist.
        </p>
      ) : null}
      {state === "ready" && record ? (
        <section aria-label="Latest recorded market event">
          <h2>Latest recorded activity</h2>
          <p data-no-translate>
            {record.latestEventType} ·{" "}
            {new Date(record.latestEventTimestamp).toLocaleString()}
          </p>
          <p>
            This is an attributed historical event, not a new execution
            confirmation.
          </p>
        </section>
      ) : null}
      <section aria-label="Independent token market observations">
        <h2>Listing and transaction history</h2>
        <p>
          These read-only sources use the exact token identity above. A missing
          catalog record does not establish that a listing or trading history is
          absent; each source reports its own availability.
        </p>
        <CurrentMarketListing asset={asset} />
        <MarketActivityHistory asset={asset} />
      </section>
      <section aria-label="Artwork rights and execution boundary">
        <h2>Rights and execution boundary</h2>
        <p>
          Judicial registration is optional. No registry evidence has been
          verified by this market view; it makes no REGISTERED or VERIFIED
          judicial-rights claim. Token ownership alone is not judicial
          ownership.
        </p>
        <p>
          ArtFi reads provider information here. This page does not request a
          signature, move an NFT, or initiate a transaction.
        </p>
      </section>
    </main>
  );
}
