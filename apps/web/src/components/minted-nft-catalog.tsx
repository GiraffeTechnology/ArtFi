"use client";
import { publicSetting } from "@/lib/public-runtime-config";
import { useEffect, useState, type FormEvent } from "react";
import {
  emptyMintFilters,
  mintCatalogQuery,
  readMintCatalogPage,
  type MintCatalogPage,
} from "@/lib/minted-nft-query";
const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");
export function MintedNFTCatalog() {
  const [catalog, setCatalog] = useState<MintCatalogPage>(),
    [page, setPage] = useState(1),
    [draft, setDraft] = useState(emptyMintFilters),
    [filters, setFilters] = useState(emptyMintFilters),
    [attempt, setAttempt] = useState(0),
    [error, setError] = useState(""),
    [inputError, setInputError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    void (async () => {
      const query = mintCatalogQuery(filters, page);
      const response = await fetch(`${apiURL}/v1/nfts?${query}`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          "The canonical mint index is unavailable. No fixture is substituted.",
        );
      const result = readMintCatalogPage(await response.json(), query);
      if (active) {
        setCatalog(result);
        setError("");
      }
    })()
      .catch(() => {
        if (active) {
          setCatalog(undefined);
          setError(
            "The canonical mint index could not be read for these filters. Retry without treating old results as current inventory.",
          );
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [filters, page, attempt]);
  function apply(event: FormEvent) {
    event.preventDefault();
    try {
      mintCatalogQuery(draft, 1);
    } catch (reason) {
      setInputError(
        reason instanceof Error ? reason.message : "Invalid mint filters.",
      );
      return;
    }
    setFilters({ ...draft });
    setPage(1);
    setCatalog(undefined);
    setError("");
    setInputError("");
    setLoading(true);
    setAttempt((v) => v + 1);
  }
  const totalPages = Math.max(1, Math.ceil((catalog?.total ?? 0) / 24));
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
          wait for OpenSea discovery. Mint observations do not establish the
          current holder, sale availability or physical rights. No preview or
          holder file is fetched.
        </p>
      </header>
      <form
        className="product-actions"
        aria-label="Filter indexed NFT mint records"
        onSubmit={apply}
      >
        <label>
          Token standard{" "}
          <select
            value={draft.standard}
            onChange={(e) => setDraft({ ...draft, standard: e.target.value })}
          >
            <option value="">All standards</option>
            <option value="ERC-721">ERC-721</option>
            <option value="ERC-1155">ERC-1155</option>
          </select>
        </label>
        <label>
          Collection address{" "}
          <input
            value={draft.collectionAddress}
            maxLength={42}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) =>
              setDraft({ ...draft, collectionAddress: e.target.value })
            }
          />
        </label>
        <label>
          Token ID{" "}
          <input
            value={draft.tokenId}
            maxLength={78}
            inputMode="numeric"
            onChange={(e) => setDraft({ ...draft, tokenId: e.target.value })}
          />
        </label>
        <label>
          Mint order{" "}
          <select
            value={draft.sort}
            onChange={(e) =>
              setDraft({
                ...draft,
                sort: e.target.value as "newest" | "oldest",
              })
            }
          >
            <option value="newest">Newest block first</option>
            <option value="oldest">Oldest block first</option>
          </select>
        </label>
        <button disabled={loading}>Apply mint filters</button>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setDraft(emptyMintFilters());
            setFilters(emptyMintFilters());
            setPage(1);
            setCatalog(undefined);
            setError("");
            setInputError("");
            setLoading(true);
            setAttempt((v) => v + 1);
          }}
        >
          Clear mint filters
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setCatalog(undefined);
            setError("");
            setLoading(true);
            setAttempt((v) => v + 1);
          }}
        >
          Refresh mint index
        </button>
      </form>
      <p data-no-translate>
        Applied: {filters.standard || "all standards"} · collection{" "}
        {filters.collectionAddress.trim() || "all"} · token{" "}
        {filters.tokenId.trim() || "all"} · {filters.sort}
      </p>
      {inputError && <p role="alert">{inputError}</p>}
      {loading && <p role="status">Loading indexed NFTs…</p>}
      {error && <p role="alert">{error} No runtime acceptance is claimed.</p>}
      {!loading && !error && catalog?.data.length === 0 && (
        <p>No canonical mint event matches these filters.</p>
      )}
      {!loading && !error && catalog && catalog.data.length > 0 && (
        <div className="minted-catalog__grid">
          {catalog.data.map((item) => (
            <article
              key={JSON.stringify([
                item.standard,
                item.collectionAddress.toLowerCase(),
                item.tokenId,
              ])}
            >
              <span className="mirror-badge">{item.standard}</span>
              <h3>Token #{item.tokenId}</h3>
              <dl>
                <div>
                  <dt>Collection</dt>
                  <dd data-no-translate>{item.collectionAddress}</dd>
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
      )}
      {!loading && !error && catalog && (
        <nav className="market-pagination" aria-label="Indexed NFT pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => {
              setCatalog(undefined);
              setLoading(true);
              setPage((v) => v - 1);
            }}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages} · {catalog.total} matching mint records
          </span>
          <button
            type="button"
            disabled={page >= totalPages || page >= 1000000}
            onClick={() => {
              setCatalog(undefined);
              setLoading(true);
              setPage((v) => v + 1);
            }}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
