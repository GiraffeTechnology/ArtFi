import type { Metadata } from "next";
import Link from "next/link";

import { CharityEditionCatalog } from "@/components/charity-edition-catalog";
import { CharityTestAssetMarkers } from "@/components/charity-test-asset-markers";

export const metadata: Metadata = { title: "Charity editions" };

export default function CharityEditionsPage() {
  return (
    <main className="approved-page page-shell">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/nft">NFT</Link>
        <span aria-hidden="true">/</span>
        <span>Charity editions</span>
      </nav>
      <CharityTestAssetMarkers />
      <div className="module-banner">
        <span>Charity NFT editions</span>
        <strong>Independent product line — not an ERC-8415 asset</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Charity</p>
        <h1>Charity editions.</h1>
        <p>
          Fixed ERC-1155 editions for cultural and philanthropic fundraising:
          one artwork, one token ID, a fixed number of units, minted once. ArtFi
          creates, signs, matches, fulfils and settles no order for these
          editions.
        </p>
      </header>
      <CharityEditionCatalog />
    </main>
  );
}
