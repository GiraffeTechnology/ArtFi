import type { Metadata } from "next";

import { DaoCreationFlow } from "@/components/dao-creation-flow";
import { DaoGovernance } from "@/components/dao-governance";

export const metadata: Metadata = { title: "DAO" };

const governanceRules = [
  ["Propose", "≥10%", "Delegated snapshot ownership"],
  ["Market migration", ">50%", "Strictly over total snapshot supply"],
  [
    "Physical action",
    ">66.6667%",
    "Warehouse, auction, sale or custodian notice",
  ],
  [
    "Forced buyout",
    ">80%",
    "Oracle-verified 30-day VWAP or last 10 actual trades",
  ],
] as const;

export default function DaoPage() {
  return (
    <main className="approved-page approved-page--dao page-shell">
      <div className="module-banner">
        <span>DAO / Base Sepolia governance</span>
        <strong>RWA ownership verification required</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Asset-owner governance</p>
        <h1>The holders govern the corresponding physical asset.</h1>
        <p>
          ArtCCH provides the asset-management interface but does not vote for
          holders. Membership, proposal rights and voting weight are verified
          from the NFT-backed Vault and its fractional token snapshots.
        </p>
      </header>

      <section className="governance-grid" aria-label="DAO approval rules">
        {governanceRules.map(([label, value, detail]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <p>{detail}</p>
          </article>
        ))}
      </section>

      <DaoCreationFlow />

      <DaoGovernance
        deployment={{
          actionRegistryAddress:
            process.env.NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS,
          governorAddress: process.env.NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS,
          tokenAddress: process.env.NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS,
          vaultAddress: process.env.NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS,
        }}
      />
    </main>
  );
}
