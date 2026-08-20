import Image from "next/image";
import Link from "next/link";

import { formatUsd, type Artwork } from "@/lib/catalog";

export function MarketMirrorCard({ artwork }: Readonly<{ artwork: Artwork }>) {
  return (
    <article className="market-mirror-card">
      <div className="market-mirror-card__artwork">
        <Image alt="" height={180} src="/brand/artwork-a.svg" width={160} />
        <span>Rights-cleared artwork</span>
      </div>
      <div className="market-mirror-card__body">
        <span className="mirror-badge">External market mirror</span>
        <h3>
          <Link href={`/market/rwa/${artwork.slug}`}>{artwork.title}</Link>
        </h3>
        <p>
          {artwork.artist} · {artwork.year} · {artwork.medium}
        </p>
        <dl>
          <div>
            <dt>Reference value</dt>
            <dd>{formatUsd(artwork.valuationUsd)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>OpenSea</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
