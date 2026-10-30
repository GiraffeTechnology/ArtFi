import type { Metadata } from "next";
import { RWAPublicationForm } from "@/components/rwa-publication";
export const metadata: Metadata = { title: "Publish a source-verified RWA" };
export default function RWAActivationPage() {
  return (
    <main className="approved-page page-shell">
      <header className="approved-page__header">
        <p className="approved-eyebrow">Approved-source correspondence</p>
        <h1>Publish a source-verified asset.</h1>
        <p>
          Review public metadata and the exact whole-receipt or fractional
          binding, then import the approved source’s signed evidence. A wallet
          session identifies the publisher; it does not establish authenticity.
        </p>
      </header>
      <RWAPublicationForm />
    </main>
  );
}
