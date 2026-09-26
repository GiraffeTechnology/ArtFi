import type { Metadata } from "next";

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
          that observation is, and the venue link the source reported. Execution
          completes on the venue: ArtFi initiates no transaction and performs no
          wallet submission, matching, custody or settlement.
        </p>
      </header>
      <LiveMarketCatalog />
    </main>
  );
}
