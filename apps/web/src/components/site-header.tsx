"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { productNavigation, toolNavigation } from "@/lib/product-lines";

import { LanguageSwitcher } from "./language-switcher";
import { UserSessionControls } from "./user-session-controls";
import { WalletButton } from "./wallet-button";

export function SiteHeader() {
  const pathname = usePathname();

  const navigationLink = ([label, href]: readonly [string, string]) => (
    <Link
      aria-current={pathname === href ? "page" : undefined}
      href={href}
      key={href}
      onClick={(event) => {
        // A current-page selection only dismisses the menu. Starting another asynchronous
        // Next navigation here can race Back/Forward and discard the forward history entry.
        if (
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.currentTarget.href === window.location.href
        )
          event.preventDefault();
        const menu = event.currentTarget.closest("details");
        if (menu) menu.open = false;
      }}
    >
      {label}
    </Link>
  );

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
          {productNavigation.map(navigationLink)}
          <details className="tools-menu" key={`tools-${pathname}`}>
            <summary>Tools</summary>
            <nav aria-label="Workflow navigation">
              {toolNavigation.map(navigationLink)}
            </nav>
          </details>
        </nav>
        <div className="header-actions">
          <LanguageSwitcher />
          <div className="desktop-wallet">
            <UserSessionControls />
            <WalletButton />
          </div>
          <details className="mobile-menu" key={`mobile-${pathname}`}>
            <summary>Menu</summary>
            <nav aria-label="Mobile navigation">
              {productNavigation.map(navigationLink)}
              {toolNavigation.map(navigationLink)}
            </nav>
          </details>
        </div>
      </div>
      <div className="mobile-wallet-controls" aria-label="Wallet controls">
        <WalletButton />
        <UserSessionControls />
      </div>
      <div className="testnet-banner">
        <span>Hoodi testnet</span>
        No real assets or real money · Wallet-confirmed writes where configured
      </div>
    </header>
  );
}
