import Link from "next/link";

import { WalletButton } from "@/components/wallet-button";
import { XionganWalletLink } from "@/components/xiongan-wallet-link";
import { productLines, toolNavigation } from "@/lib/product-lines";

export default function Home() {
  return (
    <main className="approved-overview page-shell">
      <section className="product-home-intro">
        <p className="approved-eyebrow">ArtCCH / ArtFi</p>
        <h1>Three ways to participate in art.</h1>
        <p>
          Discover digital NFTs, whole-artwork receipt assets, and fractional
          trading with DAO governance. Choose the product that matches the
          rights you want to understand.
        </p>
        <div className="overview-actions">
          <a className="primary" href="#products">
            Choose a product
          </a>
          <WalletButton />
        </div>
      </section>

      <section
        className="module-overview"
        id="products"
        aria-labelledby="product-overview-title"
      >
        <h2 id="product-overview-title">Three product lines</h2>
        <div className="module-overview__grid product-overview-grid">
          {productLines.map((product) => (
            <article className="product-card" key={product.number}>
              <span>{product.number}</span>
              <h3>{product.title}</h3>
              <p>{product.detail}</p>
              <strong>{product.label}</strong>
              <Link className="secondary" href={product.href}>
                {product.action}
              </Link>
            </article>
          ))}
        </div>
      </section>

      <aside
        className="product-runtime-notice"
        aria-label="Runtime availability"
      >
        <strong>Current environment: Hoodi testnet.</strong>
        <p>
          No real assets or real money. Runtime panels show observed records or
          explain what is unavailable. Sample artwork catalogs are explicitly
          marked as prototype fixtures. A visible workflow is not a claim that
          its contracts or services are configured.
        </p>
      </aside>

      <section className="product-tools" aria-labelledby="product-tools-title">
        <h2 id="product-tools-title">Continue an existing workflow</h2>
        <nav className="product-actions" aria-label="ArtFi tools">
          {toolNavigation.map(([label, href]) => (
            <Link className="secondary" href={href} key={href}>
              {label}
            </Link>
          ))}
          <XionganWalletLink className="secondary" />
        </nav>
      </section>
    </main>
  );
}
