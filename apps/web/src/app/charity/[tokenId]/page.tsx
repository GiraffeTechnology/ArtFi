import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CharityEditionDetail } from "@/components/charity-edition-detail";
import { CharityTestAssetMarkers } from "@/components/charity-test-asset-markers";

export const metadata: Metadata = { title: "Charity edition" };

/** Token IDs are sequential uint256 values. Anything else never reaches a contract read. */
function canonicalTokenId(value: string): string | undefined {
  if (!/^[0-9]{1,78}$/.test(value)) return undefined;
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > 2n ** 256n - 1n) return undefined;
  return parsed.toString();
}

export default async function CharityEditionPage({
  params,
}: {
  params: Promise<{ tokenId: string }>;
}) {
  const { tokenId: raw } = await params;
  const tokenId = canonicalTokenId(raw);
  if (!tokenId) notFound();

  return (
    <main className="approved-page page-shell">
      <CharityTestAssetMarkers />
      <div className="module-banner">
        <span>Charity NFT edition</span>
        <strong>
          Holder benefit released only after ownership is verified
        </strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Charity edition</p>
        <h1>Edition {tokenId}.</h1>
        <p>
          Every figure on this page is read from the editions contract. No
          artwork preview is published for a charity edition, and the
          unwatermarked master is never served by any route.
        </p>
      </header>
      <CharityEditionDetail tokenId={tokenId} />
    </main>
  );
}
