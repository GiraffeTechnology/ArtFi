import type { Metadata } from "next";

import { ArtworkCard } from "@/components/artwork-card";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Fractional Market" };

export default function FractionalMarketPage() {
  return (
    <main className="page-shell page-main">
      <header className="market-header">
        <div>
          <p className="eyebrow">Fractional market preview</p>
          <h1>Understand the position before the transaction.</h1>
        </div>
        <p>
          Prices and availability are representative fixtures. Buying, bidding,
          and claiming remain disabled until Stages 3–4.
        </p>
      </header>
      <div className="filter-bar" aria-label="Current fractional filters">
        <span>All positions</span>
        <span>Sepolia preview</span>
        <span>Read-only</span>
      </div>
      <div className="artwork-grid">
        {artworks.map((artwork) => (
          <ArtworkCard artwork={artwork} fractional key={artwork.slug} />
        ))}
      </div>
    </main>
  );
}
