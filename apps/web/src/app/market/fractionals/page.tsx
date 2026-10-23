import type { Metadata } from "next";

import { FractionalCatalog } from "@/components/fractional-catalog";

export const metadata: Metadata = { title: "Fractional Market" };

export default function FractionalMarketPage() {
  const addresses = [
    process.env.NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS,
    process.env.NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS,
    process.env.NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS,
    process.env.NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS,
  ];
  const configured = addresses.every(
    (value) =>
      typeof value === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value) &&
      value.toLowerCase() !== "0x0000000000000000000000000000000000000000",
  );
  const governance = configured
    ? {
        vaultAddress: addresses[0]!.toLowerCase(),
        tokenAddress: addresses[1]!.toLowerCase(),
      }
    : undefined;
  return (
    <main className="page-shell page-main">
      <header className="market-header">
        <div>
          <p className="eyebrow">Fund-token issuance records</p>
          <h1>Understand the position before the transaction.</h1>
        </div>
        <p>
          Read indexed issuance evidence for asset-specific fund tokens. ArtFi
          does not create, sign, match, custody, or settle marketplace orders.
        </p>
      </header>
      <FractionalCatalog governance={governance} />
    </main>
  );
}
