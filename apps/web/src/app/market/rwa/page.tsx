import type { Metadata } from "next";

import { ArtworkCard } from "@/components/artwork-card";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "RWA Market" };

export default function RwaMarketPage() {
  return (
    <main className="page-shell page-main">
      <header className="market-header">
        <div>
          <p className="eyebrow">RWA market</p>
          <h1>Documented works, ready for inspection.</h1>
        </div>
        <p>
          Stage 1 shows representative, validated metadata only. Valuations are
          fixtures and no work is offered for purchase.
        </p>
      </header>
      <div className="filter-bar" aria-label="Current catalog filters">
        <span>All works</span>
        <span>6 records</span>
        <span>Sort: recently documented</span>
      </div>
      <div className="artwork-grid">
        {artworks.map((artwork) => (
          <ArtworkCard artwork={artwork} key={artwork.slug} />
        ))}
      </div>
    </main>
  );
}
