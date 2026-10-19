"use client";
import type { RwaAsset } from "@/lib/rwa-catalog";
/** Translate fixed UI copy while preserving source-authored facts verbatim.
 * These data leaves must not enter the page translation request. */
export function RwaSourceRecord({ asset }: { asset: RwaAsset }) {
  const { binding, grounding } = asset;
  return (
    <>
      <header className="approved-page__header">
        <p className="approved-eyebrow">
          {asset.section === "whole"
            ? "Whole-artwork receipt / voucher"
            : "Fractional participation / underlying RWA"}{" "}
          · <span data-no-translate>{grounding.mode}</span>
        </p>
        <h1 data-no-translate>{asset.title}</h1>
        <p data-no-translate>
          {asset.artist} · {asset.year} · {asset.medium} · {asset.location}
        </p>
        <p data-no-translate>{asset.description}</p>
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
          Evidence status:{" "}
          <span data-no-translate>{grounding.status.replaceAll("-", " ")}</span>
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
            <dd data-no-translate>
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
            <dd data-no-translate>
              {grounding.validFrom} to {grounding.validUntil}
            </dd>
          </div>
          <div>
            <dt>Last verification</dt>
            <dd data-no-translate>{grounding.verifiedAt}</dd>
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
        <p data-no-translate>{asset.rights}</p>
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
            <li key={index} data-no-translate>
              {value}
            </li>
          ))}
        </ul>
        <p>
          Catalog revision <span data-no-translate>{asset.revision}</span> ·
          updated <span data-no-translate>{asset.updatedAt}</span>. The catalog
          contains source records, not fabricated valuations, balances or
          supply.
        </p>
      </section>
    </>
  );
}
