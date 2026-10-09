"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import {
  rwaCatalogPageSchema,
  type RwaCatalogPage,
  type RwaSection,
} from "@/lib/rwa-catalog";
export function RwaCatalog({ section }: { section: RwaSection }) {
  const [page, setPage] = useState(1),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState(""),
    [sort, setSort] = useState("updated"),
    [attempt, setAttempt] = useState(0),
    [data, setData] = useState<RwaCatalogPage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const queryString = new URLSearchParams({
        section,
        page: String(page),
        pageSize: "12",
        q: query,
        sort,
      });
      const response = await fetch(`/api/rwa/assets?${queryString}`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          "The approved-source asset catalog is unavailable. No sample is shown as live inventory.",
        );
      const result = rwaCatalogPageSchema.parse(await response.json());
      if (active) {
        setData(result);
        setError("");
      }
    })()
      .catch((reason) => {
        if (active) {
          setData(undefined);
          setError(
            reason instanceof Error
              ? reason.message
              : "The asset catalog is unavailable.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [section, page, query, sort, attempt]);
  function search(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setData(undefined);
    setPage(1);
    setQuery(draft.trim());
    setAttempt((value) => value + 1);
  }
  return (
    <section
      className="product-tools"
      aria-label={
        section === "whole"
          ? "Approved whole-artwork catalog"
          : "Approved fractional asset catalog"
      }
    >
      <h2>
        {section === "whole"
          ? "Whole-artwork source records"
          : "Fractional asset source records"}
      </h2>
      <p>
        Persisted records backed by approved-source correspondence evidence.
        Source assertions, token state and physical or registry rights remain
        separate. TEST_ONLY records are explicitly identified.
      </p>
      <form className="product-actions" onSubmit={search}>
        <label>
          Search asset records{" "}
          <input
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <label>
          Sort records{" "}
          <select
            value={sort}
            onChange={(event) => {
              setLoading(true);
              setData(undefined);
              setPage(1);
              setSort(event.target.value);
            }}
          >
            <option value="updated">Latest source update</option>
            <option value="title">Title</option>
          </select>
        </label>
        <button disabled={loading}>Search</button>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setAttempt((value) => value + 1);
          }}
        >
          Refresh asset records
        </button>
      </form>
      {loading && <p role="status">Loading source-bound assets…</p>}
      {error && <p role="status">{error}</p>}
      {data && !loading && (
        <>
          {data.data.length ? (
            <div className="nft-market-grid">
              {data.data.map((asset) => (
                <article key={asset.slug} className="nft-market-card">
                  <p>
                    {asset.grounding.mode} ·{" "}
                    {asset.grounding.status.replaceAll("-", " ")}
                  </p>
                  {asset.grounding.mode === "TEST_ONLY" && (
                    <p data-no-translate>
                      TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT
                    </p>
                  )}
                  <h3>{asset.title}</h3>
                  <p>
                    {asset.artist} · {asset.year} · {asset.medium}
                  </p>
                  <p>{asset.rights}</p>
                  <p>
                    Evidence source: {asset.grounding.sourceName} (
                    {asset.grounding.sourceKind})
                  </p>
                  <p className="nft-market-hash" data-no-translate>
                    Chain {asset.binding.chainId} ·{" "}
                    {asset.binding.collectionAddress} · token{" "}
                    {asset.binding.tokenId}
                  </p>
                  <Link
                    className="secondary"
                    href={`${section === "whole" ? "/rwa/assets" : "/market/fractionals/assets"}/${asset.slug}`}
                  >
                    Inspect source-bound asset
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <p>
              No matching approved-source asset record is present in this
              catalog.
            </p>
          )}
          <div className="product-actions">
            <button
              disabled={page === 1}
              onClick={() => {
                setLoading(true);
                setData(undefined);
                setPage((value) => value - 1);
              }}
            >
              Previous assets
            </button>
            <span>
              Page {data.page} · {data.total} records
            </span>
            <button
              disabled={data.page * data.pageSize >= data.total}
              onClick={() => {
                setLoading(true);
                setData(undefined);
                setPage((value) => value + 1);
              }}
            >
              Next assets
            </button>
          </div>
        </>
      )}
    </section>
  );
}
