"use client";

import { useCallback, useEffect, useState } from "react";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type MintedNFT = {
  standard: "ERC-721" | "ERC-1155";
  collectionAddress: string;
  tokenId: string;
  holderAddress?: string;
  metadataUri?: string;
  transactionHash: string;
  blockNumber: number;
  observedAt: string;
};

type Catalog = {
  data: MintedNFT[];
  total: number;
  page: number;
  pageSize: number;
  chainId: 560048;
  runtime: true;
};

export function MintedNFTCatalog() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const pageSize = 24;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${apiURL}/v1/nfts?page=${page}&pageSize=${pageSize}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(`NFT catalog API returned ${response.status}.`);
      const value = (await response.json()) as Catalog;
      if (
        value.runtime !== true ||
        value.chainId !== 560048 ||
        !Array.isArray(value.data)
      ) {
        throw new Error(
          "The NFT catalog response was not canonical Hoodi runtime data.",
        );
      }
      setCatalog(value);
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The NFT catalog is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil((catalog?.total ?? 0) / pageSize));
  return (
    <section
      className="minted-catalog"
      aria-labelledby="minted-catalog-title"
      aria-live="polite"
    >
      <header className="section-heading">
        <p className="approved-eyebrow">Canonical mint index</p>
        <h2 id="minted-catalog-title">
          All indexed ERC-721 and ERC-1155 NFTs.
        </h2>
        <p>
          This list is projected from confirmed Hoodi mint events and does not
          wait for OpenSea discovery. No fixture is substituted for a missing
          runtime record.
        </p>
      </header>
      {loading ? <p>Loading indexed NFTs…</p> : null}
      {error ? (
        <p role="alert">{error} No runtime acceptance is claimed.</p>
      ) : null}
      {!loading && !error && catalog?.data.length === 0 ? (
        <p>No canonical mint event has been indexed yet.</p>
      ) : null}
      {catalog && catalog.data.length > 0 ? (
        <div className="minted-catalog__grid">
          {catalog.data.map((item) => (
            <article
              key={`${item.standard}:${item.collectionAddress}:${item.tokenId}`}
            >
              <span className="mirror-badge">{item.standard}</span>
              <h3>Token #{item.tokenId}</h3>
              <dl>
                <div>
                  <dt>Collection</dt>
                  <dd>{short(item.collectionAddress)}</dd>
                </div>
                <div>
                  <dt>Block</dt>
                  <dd>{item.blockNumber}</dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd>{new Date(item.observedAt).toLocaleString()}</dd>
                </div>
              </dl>
              <a
                href={`https://hoodi.etherscan.io/tx/${item.transactionHash}`}
                target="_blank"
                rel="noreferrer"
              >
                Verify receipt ↗
              </a>
            </article>
          ))}
        </div>
      ) : null}
      {totalPages > 1 ? (
        <nav className="market-pagination" aria-label="Indexed NFT pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
