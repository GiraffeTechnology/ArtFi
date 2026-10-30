import type { Metadata } from "next";

import { PortfolioRecords } from "@/components/portfolio-records";
import { PortfolioWallet } from "@/components/portfolio-wallet";
import { WalletDaoLink } from "@/components/wallet-dao-link";
import { XionganWalletLink } from "@/components/xiongan-wallet-link";
import { XIONGAN_WALLET_DISCLOSURE } from "@/lib/xiongan-wallet";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>Wallet / read-only</span>
        <strong>No custody · Sign-in required for assets</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Wallet</p>
        <h1>Your wallet portfolio.</h1>
        <p>
          Connect a standard external wallet and sign in to view balances,
          holdings and history. Sign-in proves wallet control; it does not
          authorize a transaction. ArtFi never receives a private key or seed
          phrase.
        </p>
      </header>
      <section className="wallet-dao-link" aria-label="Xiongan Wallet DApp">
        <div>
          <p className="approved-eyebrow">External DApp</p>
          <h2>Xiongan Wallet</h2>
          <p>{XIONGAN_WALLET_DISCLOSURE}</p>
        </div>
        <div className="wallet-dao-link__actions">
          <XionganWalletLink className="external-button" />
        </div>
      </section>
      <PortfolioWallet />
      <WalletDaoLink />
      <PortfolioRecords />
    </main>
  );
}
