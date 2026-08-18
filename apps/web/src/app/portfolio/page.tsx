import type { Metadata } from "next";

import { ArtworkCard } from "@/components/artwork-card";
import { PortfolioWallet } from "@/components/portfolio-wallet";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <main className="page-shell page-main">
      <header className="page-intro page-intro--compact">
        <p className="eyebrow">Portfolio</p>
        <h1>A public-address view, never a custody claim.</h1>
      </header>
      <PortfolioWallet />
      <section className="section-block section-block--compact">
        <div className="section-heading">
          <p className="eyebrow">Illustrative watchlist</p>
          <h2>
            Positions will appear here after later-stage contracts are verified.
          </h2>
        </div>
        <div className="artwork-grid artwork-grid--two">
          {artworks.slice(0, 2).map((artwork) => (
            <ArtworkCard artwork={artwork} fractional key={artwork.slug} />
          ))}
        </div>
      </section>
    </main>
  );
}
