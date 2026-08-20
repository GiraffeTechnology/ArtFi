import type { Metadata } from "next";

import { MarketMirrorCard } from "@/components/market-mirror-card";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Market mirror" };

export default function RwaMarketPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>External market mirror</span>
        <strong>Orders execute on OpenSea</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Market mirror</p>
        <h1>Live market signals.</h1>
        <p>
          Read-only listings and sale context from approved external venues.
          ArtFi does not create, sign, match, custody or settle marketplace
          orders.
        </p>
      </header>
      <div className="filter-bar" aria-label="Current catalog filters">
        <span>All mirrored records</span>
        <span>{artworks.length} records</span>
        <span>Source: OpenSea</span>
      </div>
      <div className="market-mirror-grid">
        {artworks.map((artwork) => (
          <MarketMirrorCard artwork={artwork} key={artwork.slug} />
        ))}
      </div>
    </main>
  );
}
