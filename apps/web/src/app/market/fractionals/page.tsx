import type { Metadata } from "next";
import Link from "next/link";

import { RwaCatalog } from "@/components/rwa-catalog";
import { ArtworkCard } from "@/components/artwork-card";
import { PrototypeDataNotice } from "@/components/prototype-data-notice";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Fractional trading & DAO" };

export default function FractionalMarketPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>03 / Fractional trading &amp; DAO</span>
        <strong>
          Original ArtFi workflow · Vault, fractions and governance
        </strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Fractional positions / Asset DAO</p>
        <h1>Fractional trading &amp; DAO.</h1>
        <p>
          Continue ArtFi&apos;s original Vault and fractionalization workflow:
          organize an eligible asset, inspect fractional positions, use the
          trading controls and participate in its corresponding DAO. Economic
          participation and governance authority follow the asset model; token
          possession alone does not define governance rights.
        </p>
      </header>
      <nav className="product-actions" aria-label="Fractional and DAO actions">
        <Link className="primary" href="/dao">
          Create a Vault / open DAO
        </Link>
        <Link className="secondary" href="/portfolio">
          Verify wallet and DAO linkage
        </Link>
        <Link className="secondary" href="/projects">
          Explore asset projects
        </Link>
        <Link className="secondary" href="/market/auctions">
          Open fraction auctions
        </Link>
      </nav>
      <Link className="secondary" href="/rwa/activate">
        Publish approved-source asset evidence
      </Link>
      <RwaCatalog section="fractional" />
      <p className="product-note">
        Open a sample position to reach its existing trading controls. The
        sample prices and supply below do not describe a deployed token; trading
        panels read their configured contract state separately and report
        unavailable bindings. No real-money trading is enabled here.
      </p>
      <section
        className="product-tools"
        aria-labelledby="fraction-catalog-title"
      >
        <h2 id="fraction-catalog-title">Fractional workflow samples</h2>
        <PrototypeDataNotice />
        <div className="artwork-grid">
          {artworks.map((artwork) => (
            <ArtworkCard artwork={artwork} fractional key={artwork.slug} />
          ))}
        </div>
      </section>
    </main>
  );
}
