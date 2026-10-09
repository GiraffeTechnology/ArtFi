import type { Metadata } from "next";
import { AuctionMarket } from "@/components/auction-market";
export const metadata: Metadata = { title: "Fraction auctions" };
export default function AuctionsPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">Fractional trading / Auctions</p>
        <h1>Fraction auctions.</h1>
        <p>
          Inspect actual contract terms and history, bid through your wallet,
          and settle or withdraw confirmed credits. Market and asset
          configuration remain deployment supplied.
        </p>
      </header>
      <AuctionMarket />
    </main>
  );
}
