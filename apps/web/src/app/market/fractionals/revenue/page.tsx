import type { Metadata } from "next";
import Link from "next/link";
import { RevenueClaims } from "@/components/revenue-claims";
export const metadata: Metadata = { title: "Snapshot revenue claims" };
export default function RevenuePage() {
  return (
    <main className="approved-page page-shell">
      <h1>Fractional snapshot revenue</h1>
      <p>
        Inspect a funded round and request only your own claim from its
        configured distributor. TESTNET ONLY: no real-world value or legal
        entitlement is established by this technical flow.
      </p>
      <Link href="/market/fractionals">Return to fractional trading</Link>
      <RevenueClaims />
    </main>
  );
}
