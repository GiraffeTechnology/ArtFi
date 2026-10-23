import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MarketTokenDetail } from "@/components/market-token-detail";

export const metadata: Metadata = { title: "Observed artwork token" };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TokenDetailPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const { chain, contract, tokenId } = query;
  if (
    typeof chain !== "string" ||
    !/^[a-z][a-z0-9-]{1,31}$/.test(chain) ||
    typeof contract !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(contract) ||
    typeof tokenId !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(tokenId) ||
    BigInt(tokenId) >= 2n ** 256n
  )
    notFound();
  const asset = {
    source: "opensea",
    chain,
    contractAddress: contract.toLowerCase(),
    tokenId,
  };
  return (
    <MarketTokenDetail
      key={`${chain}:${asset.contractAddress}:${tokenId}`}
      asset={asset}
    />
  );
}
