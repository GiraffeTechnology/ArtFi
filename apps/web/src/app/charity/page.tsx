import type { Metadata } from "next";

import { CharityEditionCatalog } from "@/components/charity-edition-catalog";

export const metadata: Metadata = { title: "Charity editions" };

export default function CharityEditionsPage() {
  return (
    <main className="approved-page page-shell">
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
