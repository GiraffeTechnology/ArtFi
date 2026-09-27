import Link from "next/link";

import { formatUsd, type Artwork } from "@/lib/catalog";

import { ArtworkVisual } from "./artwork-visual";
import { AssetHolderAuthority } from "./asset-holder-authority";
import { FractionListing } from "./fraction-listing";
import { PrototypeDataNotice } from "./prototype-data-notice";
import { WholeArtworkListing } from "./whole-artwork-listing";

export function AssetDetail({
  artwork,
  fractional = false,
}: Readonly<{ artwork: Artwork; fractional?: boolean }>) {
  const available = Math.round(
    (artwork.availableFractions / artwork.totalFractions) * 100,
  );

  return (
    <main className="page-shell page-main">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href={fractional ? "/market/fractionals" : "/market/rwa"}>
          {fractional ? "Fractionals" : "RWA market"}
        </Link>
        <span aria-hidden="true">/</span>
        <span>{artwork.title}</span>
      </nav>
      <PrototypeDataNotice />
      <section className="asset-hero">
        <ArtworkVisual accent={artwork.accent} label={artwork.title} />
        <div className="asset-summary">
          <div className="card-kicker">
            <span>{artwork.status}</span>
            <span>{artwork.location}</span>
          </div>
          <h1>{artwork.title}</h1>
          <p className="asset-byline">
            {artwork.artist}, {artwork.year}
          </p>
          <p className="asset-description">{artwork.description}</p>
          <dl className="asset-metrics">
            <div>
              <dt>{fractional ? "Reference price" : "Valuation"}</dt>
              <dd>
                {formatUsd(
                  fractional ? artwork.fractionPriceUsd : artwork.valuationUsd,
                )}
              </dd>
            </div>
            <div>
              <dt>{fractional ? "Available" : "Medium"}</dt>
              <dd>{fractional ? `${available}%` : artwork.medium}</dd>
            </div>
            <div>
              <dt>{fractional ? "Total fractions" : "Network"}</dt>
              <dd>
                {fractional ? artwork.totalFractions.toLocaleString() : "Hoodi"}
              </dd>
            </div>
          </dl>
          {fractional && (
            <div className="disabled-action" role="note">
              <strong>These figures are fixture data</strong>
              <span>
                The available percentage, the reference price and the fraction
                count come from `lib/catalog.ts` and describe no deployed token.
                Settlement below reads its state from chain.
              </span>
            </div>
          )}
        </div>
      </section>
      <section className="record-grid">
        <article>
          <p className="eyebrow">Provenance record</p>
          <h2>Evidence attached to the work.</h2>
          <ol className="provenance-list">
            {artwork.provenance.map((record, index) => (
              <li key={record}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{record}</strong>
                <small>Fixture record · no immutable reference behind it</small>
              </li>
            ))}
          </ol>
        </article>
        <aside className="governance-preview">
          <p className="eyebrow">Governance preview</p>
          <h2>Controls before participation.</h2>
          <p>
            DAO roles, quorum, timelock, treasury visibility, and emergency
            controls will be published before any asset can accept value.
          </p>
          <dl>
            <div>
              <dt>Custody</dt>
              <dd>Not activated</dd>
            </div>
            <div>
              <dt>Voting</dt>
              <dd>Not activated</dd>
            </div>
            <div>
              <dt>Treasury</dt>
              <dd>No funds</dd>
            </div>
          </dl>
        </aside>
      </section>
      {fractional ? <FractionListing /> : <WholeArtworkListing />}
      {!fractional && <AssetHolderAuthority />}
    </main>
  );
}
