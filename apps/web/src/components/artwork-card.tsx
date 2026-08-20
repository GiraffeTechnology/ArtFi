import Link from "next/link";

import { formatUsd, type Artwork } from "@/lib/catalog";

import { ArtworkVisual } from "./artwork-visual";

export function ArtworkCard({
  artwork,
  fractional = false,
}: Readonly<{ artwork: Artwork; fractional?: boolean }>) {
  const href = fractional
    ? `/market/fractionals/${artwork.slug}`
    : `/market/rwa/${artwork.slug}`;
  const available = Math.round(
    (artwork.availableFractions / artwork.totalFractions) * 100,
  );

  return (
    <article className="artwork-card">
      <Link href={href} aria-label={`View ${artwork.title}`}>
        <ArtworkVisual accent={artwork.accent} label={artwork.title} compact />
      </Link>
      <div className="artwork-card__body">
        <div className="card-kicker">
          <span>{artwork.status}</span>
          <span>{artwork.location}</span>
        </div>
        <h3>
          <Link href={href}>{artwork.title}</Link>
        </h3>
        <p className="artist-line">
          {artwork.artist}, {artwork.year}
        </p>
        <div className="card-value">
          <div>
            <small>
              {fractional ? "Reference price" : "Independent valuation"}
            </small>
            <strong>
              {fractional
                ? formatUsd(artwork.fractionPriceUsd)
                : formatUsd(artwork.valuationUsd)}
            </strong>
          </div>
          {fractional ? (
            <span>{available}% available</span>
          ) : (
            <span>{artwork.medium}</span>
          )}
        </div>
      </div>
    </article>
  );
}
