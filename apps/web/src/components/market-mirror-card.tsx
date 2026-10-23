import Image from "next/image";
import Link from "next/link";

import { formatUsd, type Artwork } from "@/lib/catalog";

export function MarketMirrorCard({ artwork }: Readonly<{ artwork: Artwork }>) {
  return (
    <article className="market-mirror-card">
      <div className="market-mirror-card__artwork">
        <Image alt="" height={180} src="/brand/artwork-a.svg" width={160} />
        <span>Illustrative artwork placeholder</span>
      </div>
      <div className="market-mirror-card__body">
        <span className="mirror-badge">
          Example artwork · not live market data
        </span>
        <h3>
          <Link href={`/market/rwa/${artwork.slug}`}>{artwork.title}</Link>
        </h3>
        <p>
          {artwork.artist} · {artwork.year} · {artwork.medium}
        </p>
        <dl>
          <div>
            <dt>Illustrative value</dt>
            <dd>{formatUsd(artwork.valuationUsd)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>Local example · no provider lookup</dd>
          </div>
        </dl>
        <p>
          This example has no verified token, listing or judicial-rights
          binding.{" "}
          <Link href="/market/rwa">View attributed market records</Link> for
          runtime observations.
        </p>
      </div>
    </article>
  );
}
