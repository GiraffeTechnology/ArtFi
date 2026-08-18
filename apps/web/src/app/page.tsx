import Link from "next/link";

import { ArtworkCard } from "@/components/artwork-card";
import { ArtworkVisual } from "@/components/artwork-visual";
import { artworks, formatUsd, projects } from "@/lib/catalog";

const featured = artworks[0];

export default function Home() {
  return (
    <main>
      <section className="home-hero page-shell">
        <div className="home-hero__copy">
          <p className="eyebrow">Verified art infrastructure</p>
          <h1>Art ownership, with the record attached.</h1>
          <p className="lede">
            Explore curated works, inspect provenance, and connect a wallet to
            preview your ArtFi portfolio on Sepolia. Every action is staged,
            reviewable, and testnet-only.
          </p>
          <div className="actions">
            <Link className="primary" href="/market/rwa">
              Explore RWA market
            </Link>
            <Link className="secondary" href="/projects">
              View projects
            </Link>
          </div>
          <dl className="hero-metrics">
            <div>
              <dt>Curated projects</dt>
              <dd>{projects.length}</dd>
            </div>
            <div>
              <dt>Documented works</dt>
              <dd>{artworks.length}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Sepolia</dd>
            </div>
          </dl>
        </div>
        <Link className="featured-work" href={`/market/rwa/${featured.slug}`}>
          <ArtworkVisual accent={featured.accent} label={featured.title} />
          <div className="featured-work__caption">
            <div>
              <span>Featured record</span>
              <strong>{featured.title}</strong>
            </div>
            <div>
              <span>Independent valuation</span>
              <strong>{formatUsd(featured.valuationUsd)}</strong>
            </div>
          </div>
        </Link>
      </section>

      <section className="editorial-band">
        <div className="page-shell editorial-band__inner">
          <p className="eyebrow">A legible asset journey</p>
          <h2>From curatorial record to governed participation.</h2>
          <div className="journey-grid">
            {[
              [
                "01",
                "Inspect",
                "Review origin, material, location, condition, and custody context.",
              ],
              [
                "02",
                "Connect",
                "Use a standard browser wallet with Sepolia network enforcement.",
              ],
              [
                "03",
                "Participate",
                "Preview fractional positions without enabling write transactions.",
              ],
              [
                "04",
                "Govern",
                "Understand the proposal and treasury model before it is activated.",
              ],
            ].map(([number, title, description]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="page-shell section-block">
        <div className="section-heading section-heading--row">
          <div>
            <p className="eyebrow">Current records</p>
            <h2>Works with context, not just a token.</h2>
          </div>
          <Link className="text-link" href="/market/rwa">
            Browse all works <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="artwork-grid">
          {artworks.slice(0, 3).map((artwork) => (
            <ArtworkCard artwork={artwork} key={artwork.slug} />
          ))}
        </div>
      </section>

      <section className="page-shell safety-panel">
        <div>
          <p className="eyebrow">Stage 1 release boundary</p>
          <h2>Wallet-aware. Transaction-free.</h2>
        </div>
        <p>
          This release reads public wallet and testnet data only. Minting,
          deposits, sales, bids, claims, and governance execution remain
          disabled until their contracts and controls pass later-stage review
          gates.
        </p>
      </section>
    </main>
  );
}
