import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: {
    default: "ArtFi | Art with a verifiable record",
    template: "%s | ArtFi",
  },
  description:
    "A Sepolia-first, auditable platform for real-world art assets and shared ownership.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <SiteHeader />
          {children}
          <footer className="site-footer">
            <div>
              <span className="brand">ArtFi</span>
              <p>Evidence before claims. Testnet before value.</p>
            </div>
            <div>
              <a href="https://github.com/GiraffeTechnology/ArtFi">GitHub</a>
              <a href="https://sepolia.etherscan.io">Sepolia explorer</a>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
