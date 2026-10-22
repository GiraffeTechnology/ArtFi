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
import { RwaSourceRecord } from "./rwa-source-record";
import { NativeMarketAnalyticsPanel } from "./native-market-analytics";
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
      <RwaSourceRecord asset={asset} />
      <NativeMarketAnalyticsPanel asset={asset} />
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
            registryBacked={grounding.registryBacked}
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
