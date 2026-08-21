import type { Metadata } from "next";

import { LiveMarketCatalog } from "@/components/live-market-catalog";

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
          Runtime listings and sale context from approved external venues. When
          separately enabled, ArtFi can request an unsigned fulfillment plan and
          pass it to your wallet; OpenSea remains the executing venue.
        </p>
      </header>
      <LiveMarketCatalog />
    </main>
  );
}
