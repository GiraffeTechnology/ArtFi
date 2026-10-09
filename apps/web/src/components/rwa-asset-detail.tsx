"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  rwaAssetSchema,
  rwaAssetIdentity,
  type RwaAsset,
  type RwaSection,
} from "@/lib/rwa-catalog";
import { WholeArtworkListing } from "./whole-artwork-listing";
import { FractionListing } from "./fraction-listing";
import { AssetHolderAuthority } from "./asset-holder-authority";
export function RwaAssetDetail({
  slug,
  section,
}: {
  slug: string;
  section: RwaSection;
}) {
  return (
    <RwaAssetLoader key={`${section}:${slug}`} slug={slug} section={section} />
  );
}
function RwaAssetLoader({
  slug,
  section,
}: {
  slug: string;
  section: RwaSection;
}) {
  const [asset, setAsset] = useState<RwaAsset>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const response = await fetch(
        `/api/rwa/assets/${encodeURIComponent(slug)}`,
        {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "This approved-source asset record was not found."
            : "The source-bound asset record is unavailable. No sample or guessed binding is substituted.",
        );
      const value = rwaAssetSchema.parse(await response.json());
      if (value.slug !== slug || value.section !== section)
        throw new Error(
          "The source record belongs to a different asset or product section.",
        );
      if (active) {
        setAsset(value);
        setError("");
      }
    })()
      .catch((reason) => {
        if (active) {
          setAsset(undefined);
          setError(
            reason instanceof Error
              ? reason.message
              : "The asset record is unavailable.",
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
  }, [slug, section, attempt]);
  return (
    <main className="page-shell page-main">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href={section === "whole" ? "/rwa" : "/market/fractionals"}>
          {section === "whole"
            ? "Whole-artwork source records"
            : "Fractional source records"}
        </Link>
      </nav>
      <button
        className="secondary"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setAsset(undefined);
          setAttempt((value) => value + 1);
        }}
      >
        Refresh approved-source record
      </button>
      {loading && (
        <p role="status">
          Loading the asset and its signed correspondence record…
        </p>
      )}
      {error && <p role="status">{error}</p>}
      {asset && !loading && <RwaAssetDetailView asset={asset} />}
    </main>
  );
}
export function RwaAssetDetailView({ asset }: { asset: RwaAsset }) {
  const binding = asset.binding,
    grounding = asset.grounding;
  return (
    <>
      <header className="approved-page__header">
        <p className="approved-eyebrow">
          {asset.section === "whole"
            ? "Whole-artwork receipt / voucher"
            : "Fractional participation / underlying RWA"}{" "}
          · {grounding.mode}
        </p>
        <h1>{asset.title}</h1>
        <p>
          {asset.artist} · {asset.year} · {asset.medium} · {asset.location}
        </p>
        <p>{asset.description}</p>
      </header>
      <section
        className="product-tools"
        aria-label="Approved-source correspondence"
      >
        <h2>Source correspondence evidence</h2>
        {grounding.mode === "TEST_ONLY" && (
          <p data-no-translate>
            <strong>TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT</strong>
          </p>
        )}
        <p>
          {grounding.mode === "TEST_ONLY"
            ? "Isolated TEST_ONLY evidence. This record does not authenticate a real asset or authorize real-value activity."
            : "This record carries correspondence evidence from the named approved source. ArtFi verifies that evidence; it does not become the source or a registry."}
        </p>
        <p role="status">
          Evidence status: {grounding.status.replaceAll("-", " ")}
        </p>
        {grounding.status !== "verified" && (
          <p>
            New listing, approval and purchase actions require current
            approved-source evidence. Owner revocation and existing settlement
            or withdrawal exits are not frozen by this status.
          </p>
        )}
        <dl className="contract-facts">
          <div>
            <dt>Evidence source</dt>
            <dd>
              {grounding.sourceName} · {grounding.sourceId} ·{" "}
              {grounding.sourceKind}
            </dd>
          </div>
          <div>
            <dt>Source reference</dt>
            <dd data-no-translate>{grounding.sourceReference}</dd>
          </div>
          <div>
            <dt>Evidence digest</dt>
            <dd className="nft-market-hash" data-no-translate>
              {grounding.evidenceSha256}
            </dd>
          </div>
          <div>
            <dt>Signed validity window</dt>
            <dd>
              {grounding.validFrom} to {grounding.validUntil}
            </dd>
          </div>
          <div>
            <dt>Last verification</dt>
            <dd>{grounding.verifiedAt}</dd>
          </div>
          <div>
            <dt>Bound token</dt>
            <dd className="nft-market-hash" data-no-translate>
              Chain {binding.chainId} · {binding.collectionAddress} · token{" "}
              {binding.tokenId}
            </dd>
          </div>
          {binding.fractionTokenAddress && (
            <div>
              <dt>Bound fraction token</dt>
              <dd data-no-translate>{binding.fractionTokenAddress}</dd>
            </div>
          )}
          {binding.vaultAddress && (
            <div>
              <dt>Bound vault</dt>
              <dd data-no-translate>{binding.vaultAddress}</dd>
            </div>
          )}
          {binding.marketAddress && (
            <div>
              <dt>Bound settlement market</dt>
              <dd data-no-translate>{binding.marketAddress}</dd>
            </div>
          )}
        </dl>
        <h3>Rights stated by the source</h3>
        <p>{asset.rights}</p>
        <p>
          {grounding.registryBacked
            ? "The registry of record remains the authority for recorded holdership within its scope. Token transfer alone is not registry transfer."
            : "This record uses the stated non-registry evidence and enforceable-right model. It is not represented as a registry ownership record."}{" "}
          Token possession alone does not establish physical title, delivery,
          redemption or additional governance rights.
        </p>
        <h3>Attributed evidence references</h3>
        <ul>
          {asset.provenance.map((value, index) => (
            <li key={index}>{value}</li>
          ))}
        </ul>
        <p>
          Catalog revision {asset.revision} · updated {asset.updatedAt}. The
          catalog contains source records, not fabricated valuations, balances
          or supply.
        </p>
      </section>
      {binding.chainId === 560048 && binding.marketAddress ? (
        asset.section === "whole" ? (
          <WholeArtworkListing
            key={rwaAssetIdentity(asset)}
            slug={asset.slug}
            catalogSlug={asset.slug}
            catalogIdentity={rwaAssetIdentity(asset)}
            collection={binding.collectionAddress}
            tokenId={binding.tokenId}
            marketAddress={binding.marketAddress}
          />
        ) : binding.fractionTokenAddress ? (
          <FractionListing
            key={rwaAssetIdentity(asset)}
            slug={asset.slug}
            catalogSlug={asset.slug}
            catalogIdentity={rwaAssetIdentity(asset)}
            assetToken={binding.fractionTokenAddress}
            marketAddress={binding.marketAddress}
          />
        ) : (
          <p>
            The source record has no bound fraction token. No fractional
            position is invented.
          </p>
        )
      ) : (
        <p>
          Native settlement for this record is not configured on the
          application&apos;s Hoodi execution path. Source inspection remains
          available.
        </p>
      )}
      {(asset.section === "whole" || grounding.registryBacked) && (
        <AssetHolderAuthority
          key={`${asset.slug}:${rwaAssetIdentity(asset)}`}
          slug={asset.slug}
          sourceCatalog
        />
      )}
    </>
  );
}
