import Image from "next/image";
import Link from "next/link";

import { WalletButton } from "./wallet-button";

const navigation = [
  ["Overview", "/"],
  ["Market mirror", "/market/rwa"],
  ["Wallet", "/portfolio"],
  ["DAO", "/dao"],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="ArtCCH ArtFi home">
          <Image
            alt="ArtCCH"
            className="brand-logo"
            height={38}
            priority
            src="/brand/artcch-logo-master.svg"
            width={152}
          />
          <span>: ArtFi</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([label, href]) => (
            <Link href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="desktop-wallet">
          <WalletButton />
        </div>
        <details className="mobile-menu">
          <summary>Menu</summary>
          <nav aria-label="Mobile navigation">
            {navigation.map(([label, href]) => (
              <Link href={href} key={href}>
                {label}
              </Link>
            ))}
          </nav>
        </details>
      </div>
      <div className="testnet-banner">
        <span>Testnet / read-only</span>
        No custody · No in-app order execution · External marketplace data
      </div>
    </header>
  );
}
