import type { Metadata } from "next";
import Link from "next/link";

import { LiveMarketCatalog } from "@/components/live-market-catalog";

export const metadata: Metadata = { title: "Market mirror" };

export default function RwaMarketPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>External market mirror</span>
        <strong>OpenSea information mirror only</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Market mirror</p>
        <h1>Live market signals.</h1>
        <p>
          Read-only listings and sale context from approved external venues,
          each attributed to its source with the time it was observed, how fresh
          that observation is, and the reference the source reported. This
          activity catalog does not submit orders. Configured digital
          collections can be browsed and traded through ArtFi’s native NFT
          marketplace.
        </p>
      </header>
      <Link className="secondary" href="/nft">
        Open the native NFT marketplace
      </Link>
      <LiveMarketCatalog />
    </main>
  );
}
