import type { Metadata } from "next";
import Link from "next/link";

import { ArtworkCard } from "@/components/artwork-card";
import { PrototypeDataNotice } from "@/components/prototype-data-notice";
import { artworks } from "@/lib/catalog";

export const metadata: Metadata = { title: "Whole-artwork RWA" };

export default function WholeRwaPage() {
  return (
    <main className="approved-page page-shell">
      <div className="module-banner">
        <span>02 / Whole-artwork RWA</span>
        <strong>Pickup voucher / warehouse receipt · ERC-8415</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Whole artwork / Receipt asset</p>
        <h1>One artwork. Its receipt. Its record.</h1>
        <p>
          The token represents a pickup voucher or warehouse receipt for the
          corresponding whole artwork. ERC-8415 supports asset identity,
          registry synchronization and lifecycle management for this commercial
          product. The registry of record is the holder authority; ArtFi
          displays its projection and reports discrepancies.
        </p>
      </header>
      <nav className="product-actions" aria-label="Whole-artwork actions">
        <Link className="primary" href="/create/rwa">
          Create an RWA record on Hoodi
        </Link>
        <Link className="secondary" href="/market/rwa">
          Open live market mirror
        </Link>
        <Link className="secondary" href="/portfolio">
          View wallet records
        </Link>
      </nav>
      <p className="product-note">
        Open a sample artwork below to inspect the receipt model, holder
        authority and existing whole-artwork transaction controls. Configured
        runtime bindings determine which Hoodi actions are available. No
        physical delivery, real-asset title or live inventory is claimed here.
      </p>

      <section className="product-tools" aria-labelledby="rwa-catalog-title">
        <h2 id="rwa-catalog-title">Whole-artwork workflow samples</h2>
        <PrototypeDataNotice />
        <div className="artwork-grid">
          {artworks.map((artwork) => (
            <ArtworkCard artwork={artwork} key={artwork.slug} />
          ))}
        </div>
      </section>
    </main>
  );
}
