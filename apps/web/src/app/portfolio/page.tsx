import type { Metadata } from "next";

import { PortfolioRecords } from "@/components/portfolio-records";
import { PortfolioWallet } from "@/components/portfolio-wallet";
import { WalletDaoLink } from "@/components/wallet-dao-link";

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
      <WalletDaoLink />
      <PortfolioRecords />
    </main>
  );
}
