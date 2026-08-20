import type { Metadata } from "next";
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
    "A Sepolia-first, auditable platform for real-world art assets and shared ownership.",
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
            <p>Technical support: Giraffe ArtFi Corp.</p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
