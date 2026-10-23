import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DaoCreationFlow } from "@/components/dao-creation-flow";
import { DaoGovernance } from "@/components/dao-governance";

export const metadata: Metadata = { title: "DAO" };

const governanceRules = [
  ["Propose", "≥10%", "Delegated snapshot voting power"],
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

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DaoPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const deployment = {
    actionRegistryAddress: process.env.NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS,
    governorAddress: process.env.NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS,
    tokenAddress: process.env.NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS,
    vaultAddress: process.env.NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS,
  };
  const requestedFund =
    query.chainId !== undefined ||
    query.vault !== undefined ||
    query.token !== undefined;
  if (
    requestedFund &&
    (query.chainId !== "560048" ||
      typeof query.vault !== "string" ||
      typeof query.token !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(query.vault) ||
      !/^0x[0-9a-fA-F]{40}$/.test(query.token) ||
      query.vault.toLowerCase() !== deployment.vaultAddress?.toLowerCase() ||
      query.token.toLowerCase() !== deployment.tokenAddress?.toLowerCase() ||
      !Object.values(deployment).every(
        (value) =>
          typeof value === "string" &&
          /^0x[0-9a-fA-F]{40}$/.test(value) &&
          value.toLowerCase() !== "0x0000000000000000000000000000000000000000",
      ))
  )
    notFound();
  return (
    <main className="approved-page approved-page--dao page-shell">
      <Link href="/market/fractionals">Back to fund-token issuances</Link>
      <div className="module-banner">
        <span>DAO / Hoodi governance</span>
        <strong>Fund-specific authority and wallet verification</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Single-asset fund governance</p>
        <h1>Participate under the corresponding fund's rules.</h1>
        <p>
          This interface serves the configured NFT-backed fund and its
          fractional token snapshots. Membership, proposal rights and voting
          weight follow that product's contracts and authority model. A token
          balance or wallet signature alone does not establish judicial
          ownership of the artwork.
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

      <section className="dao-panel" aria-label="Configured fund identity">
        <h2>Configured Hoodi fund</h2>
        <p>
          TEST_ONLY_NO_REAL_VALUE. These are configuration references, not a
          fresh chain verification or a judicial-rights assertion.
        </p>
        <dl style={{ overflowWrap: "anywhere" }}>
          <div>
            <dt>Vault</dt>
            <dd data-no-translate>
              {deployment.vaultAddress || "Not configured"}
            </dd>
          </div>
          <div>
            <dt>Fund token</dt>
            <dd data-no-translate>
              {deployment.tokenAddress || "Not configured"}
            </dd>
          </div>
          <div>
            <dt>Governor</dt>
            <dd data-no-translate>
              {deployment.governorAddress || "Not configured"}
            </dd>
          </div>
          <div>
            <dt>Action registry</dt>
            <dd data-no-translate>
              {deployment.actionRegistryAddress || "Not configured"}
            </dd>
          </div>
        </dl>
      </section>
      <DaoGovernance deployment={deployment} />
    </main>
  );
}
