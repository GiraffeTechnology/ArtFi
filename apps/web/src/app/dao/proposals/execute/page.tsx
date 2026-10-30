import type { Metadata } from "next";
import Link from "next/link";
import { DaoPublishedExecution } from "@/components/dao-published-execution";
import { publicSetting } from "@/lib/public-runtime-config";

export const metadata: Metadata = { title: "Published DAO proposal execution" };
export default function PublishedDaoExecutionPage() {
  return (
    <main className="approved-page approved-page--dao page-shell">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/dao">DAO</Link>
        <span>Published proposal</span>
      </nav>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Existing asset DAO / Hoodi</p>
        <h1>Review and continue a published proposal.</h1>
        <p>
          Load original chain terms even when this browser did not create the
          proposal. Existing snapshot voting, approval thresholds and timelock
          authority remain with the configured contracts.
        </p>
      </header>
      <DaoPublishedExecution
        deployment={{
          actionRegistryAddress: publicSetting(
            "NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS",
          ),
          governorAddress: publicSetting("NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS"),
          tokenAddress: publicSetting(
            "NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS",
          ),
          vaultAddress: publicSetting("NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS"),
        }}
      />
    </main>
  );
}
