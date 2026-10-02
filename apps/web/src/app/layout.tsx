import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";

import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: {
    default: "ArtCCH:ArtFi | Art with a verifiable record",
    template: "%s | ArtCCH:ArtFi",
  },
  description:
    "NFT collectibles, whole-artwork receipt assets, and fractional trading with DAO governance. Hoodi testnet workflows with explicit runtime availability.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body data-translation-root>
        <Providers>
          <SiteHeader />
          {children}
          <footer className="site-footer">
            <p>
              ArtCCH:ArtFi · Where living traditions become contemporary art.
            </p>
            <p
              className="technical-support"
              data-no-translate
              data-translation-skip
            >
              <span className="technical-support__label">
                Technical support:
              </span>
              <span className="technical-support__mark" aria-hidden="true">
                <Image
                  src="/brand/giraffe-head-color.png"
                  width={40}
                  height={40}
                  alt=""
                />
              </span>
              <span className="technical-support__name">
                Giraffe ArtFi Corp.
              </span>
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
