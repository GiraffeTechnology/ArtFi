import type { Metadata } from "next";

import { ArtworkCard } from "@/components/artwork-card";
import { PortfolioWallet } from "@/components/portfolio-wallet";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>Wallet / read-only</span>
        <strong>No custody · No signature for viewing</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Wallet</p>
        <h1>Your public portfolio.</h1>
        <p>
          Connect a standard external wallet to read public Sepolia state. ArtFi
          never receives a private key or seed phrase.
        </p>
      </header>
      <PortfolioWallet />
      <section className="section-block section-block--compact">
        <div className="section-heading">
          <p className="approved-eyebrow">Visible positions</p>
          <h2>Public records associated with this address.</h2>
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
