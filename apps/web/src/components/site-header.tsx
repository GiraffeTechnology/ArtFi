import Link from "next/link";

import { WalletButton } from "./wallet-button";

const navigation = [
  ["Projects", "/projects"],
  ["RWA Market", "/market/rwa"],
  ["Fractionals", "/market/fractionals"],
  ["Portfolio", "/portfolio"],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="ArtFi home">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>ArtFi</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([label, href]) => (
            <Link href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
        <WalletButton />
      </div>
      <div className="testnet-banner">
        <span>Sepolia testnet</span>
        Read-only product preview · transactions are disabled in Stage 1
      </div>
    </header>
  );
}
