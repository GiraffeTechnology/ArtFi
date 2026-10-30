import type { Metadata } from "next";

import { MarketActivityHistory } from "@/components/market-activity-history";

export const metadata: Metadata = { title: "Market activity" };

export default function MarketActivityPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>External marketplace mirror</span>
        <strong>Read-only — execution completes on the venue</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Market</p>
        <h1>The mirrored history.</h1>
        <p>
          Every listing, offer, sale, transfer and cancellation ArtFi has
          observed on an approved external marketplace, walkable end to end
          rather than capped at the most recent page.
        </p>
      </header>
      <MarketActivityHistory />
    </main>
  );
}
