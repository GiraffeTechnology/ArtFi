import type { Metadata } from "next";
import { ProductHelp } from "@/components/product-help";

export const metadata: Metadata = {
  title: "Help and frequently asked questions",
  description:
    "Guidance for digital editions, whole-artwork receipts, fractions, wallet access, order results and protected holder files.",
};

export default function HelpPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">ArtCCH:ArtFi help</p>
        <h1>Help and frequently asked questions.</h1>
        <p>
          Choose a topic or open a question below. This guide explains the
          product and its existing workflows; the current record in the
          corresponding screen determines availability and status.
        </p>
      </header>
      <ProductHelp />
    </main>
  );
}
