import type { Metadata } from "next";
import Link from "next/link";

import { NftMarket } from "@/components/nft-market";
import { CharityEditionCatalog } from "@/components/charity-edition-catalog";
import { CharityTestAssetMarkers } from "@/components/charity-test-asset-markers";

export const metadata: Metadata = { title: "NFT" };

export default function NftPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>01 / NFT</span>
        <strong>Digital collectibles · No real-world asset backing</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">NFT / CCHS / OpenSea</p>
        <h1>Digital art, independently collected.</h1>
        <p>
          This product line is for NFTs without real-world asset backing. It
          connects with CCHS at cchsc.ca and uses OpenSea as its primary
          integrated venue. These NFTs are not warehouse receipts, physical
          artwork ownership or fractional investment positions.
        </p>
      </header>
      <nav className="product-actions" aria-label="NFT actions">
        <a className="primary" href="#native-nft-title">
          Browse native NFT marketplace
        </a>
        <a
          className="secondary"
          href="https://cchsc.ca/"
          target="_blank"
          rel="noreferrer"
        >
          Visit CCHS ↗
        </a>
        <Link className="secondary" href="/market/rwa">
          View observed marketplace records
        </Link>
      </nav>
      <NftMarket />

      <section
        className="product-tools"
        id="nft-editions"
        aria-labelledby="nft-charity-title"
      >
        <header className="section-heading">
          <p className="approved-eyebrow">Independent Charity capability</p>
          <h2 id="nft-charity-title">Charity editions</h2>
          <p>
            Keep cultural and philanthropic editions separate from RWA receipt
            assets. Inspect the edition terms and observed marketplace records,
            and verify holder access on an edition&apos;s detail page.
          </p>
        </header>
        <nav className="product-actions" aria-label="Charity actions">
          <Link className="secondary" href="/charity">
            Open Charity editions
          </Link>
          <Link className="secondary" href="/create/rwa?standard=erc1155">
            Create a charity edition on Hoodi
          </Link>
        </nav>
        <CharityTestAssetMarkers />
        <CharityEditionCatalog />
      </section>
    </main>
  );
}
