import type { Metadata } from "next";
import Link from "next/link";

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
          primarily connects with CCHS at cchsc.ca, with trading primarily on
          OpenSea. These NFTs are not warehouse receipts, physical artwork
          ownership or fractional investment positions.
        </p>
      </header>
      <nav className="product-actions" aria-label="NFT actions">
        <a
          className="primary"
          href="https://opensea.io/"
          target="_blank"
          rel="noreferrer"
        >
          Visit OpenSea ↗
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
      <p className="product-note">
        OpenSea and CCHS links above open their homepages. They do not assert
        that an ArtFi collection is listed or available to buy. Asset-specific
        marketplace links appear only when reported by the observed source.
      </p>

      <section className="product-tools" aria-labelledby="nft-charity-title">
        <header className="section-heading">
          <p className="approved-eyebrow">Independent Charity capability</p>
          <h2 id="nft-charity-title">Charity editions</h2>
          <p>
            Keep cultural and philanthropic editions separate from RWA receipt
            assets. Inspect the edition terms, follow an observed OpenSea link,
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
