import Image from "next/image";
import Link from "next/link";

import { MarketMirrorCard } from "@/components/market-mirror-card";
import { WalletButton } from "@/components/wallet-button";
import { artworks } from "@/lib/catalog";

const modules = [
  {
    detail: "Live listings and sale signals from compliant external venues.",
    href: "/market/rwa",
    label: "External link only",
    number: "01",
    title: "Market mirror",
  },
  {
    detail: "Authorized ERC-721 records and fixed ERC-1155 edition controls.",
    href: "/create/rwa",
    label: "External wallet confirmation",
    number: "02",
    title: "Mint",
  },
  {
    detail: "Public-address portfolio and testnet network visibility.",
    href: "/portfolio",
    label: "No private-key custody",
    number: "03",
    title: "Wallet",
  },
  {
    detail: "Proposal, quorum, treasury and role transparency.",
    href: "/dao",
    label: "Execution interface reserved",
    number: "04",
    title: "DAO",
  },
] as const;

export default function Home() {
  return (
    <main className="approved-overview page-shell">
      <section className="overview-hero">
        <div className="overview-hero__copy">
          <p className="approved-eyebrow">ArtCCH / ArtFi</p>
          <h1>Art, provenance, and transparent ownership.</h1>
          <p className="overview-hero__lede">
            A trusted entry point for curated art assets: inspect provenance,
            connect an external wallet, and understand markets and governance in
            one interface.
          </p>
          <div className="overview-actions">
            <a
              className="external-button"
              href="https://opensea.io"
              rel="noreferrer"
              target="_blank"
            >
              <Image
                alt=""
                height={16}
                src="/brand/external-link.svg"
                width={16}
              />
              View on OpenSea
            </a>
            <WalletButton />
          </div>
        </div>
        <MarketMirrorCard artwork={artworks[0]} />
      </section>

      <section
        className="module-overview"
        aria-labelledby="module-overview-title"
      >
        <h2 id="module-overview-title">Four controlled layers</h2>
        <div className="module-overview__grid">
          {modules.map((module) => (
            <Link href={module.href} key={module.number}>
              <article>
                <span>{module.number}</span>
                <h3>{module.title}</h3>
                <p>{module.detail}</p>
                <strong>{module.label}</strong>
              </article>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
