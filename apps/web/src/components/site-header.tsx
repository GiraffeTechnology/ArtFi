import Image from "next/image";
import Link from "next/link";

import { LanguageSwitcher } from "./language-switcher";
import { WalletButton } from "./wallet-button";

const navigation = [
  ["Overview", "/"],
  ["Market mirror", "/market/rwa"],
  ["Mint", "/create/rwa"],
  ["Wallet", "/portfolio"],
  ["DAO", "/dao"],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link
          className="brand"
          data-no-translate
          href="/"
          aria-label="ArtCCH TM: ArtFi home"
        >
          <Image
            alt="ArtCCH"
            className="brand-logo"
            height={22}
            priority
            src="/brand/artcch-logo-master.svg"
            width={88}
          />
          <sup className="brand-trademark" aria-hidden="true">
            ™
          </sup>
          <span className="brand-product" aria-hidden="true">
            ：ArtFi
          </span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([label, href]) => (
            <Link href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <LanguageSwitcher />
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
      </div>
      <div className="testnet-banner">
        <span>Testnet / read-only</span>
        No custody · External market information mirror only · Attributed runtime
        data
      </div>
    </header>
  );
}
