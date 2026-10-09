"use client";

import { publicSetting } from "@/lib/public-runtime-config";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatEther, isAddress, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";

import { charityEditionsAbi } from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";

import { CharityEditionRightsNotice } from "./charity-edition-rights-notice";

/**
 * The public charity-edition surface — #110 §2 CH.1, CH.2, CH.7 and CH.8.
 *
 * Every figure on this page is read from the editions contract on the configured chain. There is
 * no fixture behind it and no "sample edition": when the contract address is unset or the chain is
 * unreachable the page says so and lists nothing, because `ACCEPTANCE.md` §7.5 and §7.7 fail an
 * audit that shows static data where runtime data is claimed.
 *
 * What is deliberately absent is as much the point as what is shown. There is no artwork image
 * anywhere on this surface (CH.7), and no buy, bid or transfer control (CH.2 — ArtFi creates,
 * signs, matches, fulfils and settles nothing for these editions).
 */

export type CharityEdition = {
  tokenId: string;
  artworkId: Hex;
  distributionWallet: Address;
  mintedUnits: bigint;
  distributorUnits: bigint;
  soldOutAt: number;
  physicalDonationRecordedAt: number;
};

type SeriesTuple = {
  artworkId: Hex;
  distributionWallet: Address;
  soldOutAt: bigint;
  physicalDonationRecordedAt: bigint;
};

type LoadState = "loading" | "ready" | "unconfigured" | "error";

export function editionAvailability(edition: CharityEdition): string {
  if (edition.soldOutAt > 0) return "Sellout recorded";
  if (edition.distributorUnits === 0n) {
    // Zero at the distributor is necessary for sellout but not sufficient: CH.3 requires external
    // reconciliation first. Saying "sold out" here would report a state the chain has not recorded.
    return "Distribution wallet empty — sellout not yet recorded";
  }
  return `${edition.distributorUnits} of ${edition.mintedUnits} held by the distribution wallet`;
}

export function CharityEditionCatalog() {
  const configuredAddress = publicSetting(
    "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  );
  const contractAddress = (
    isAddress(configuredAddress ?? "") ? configuredAddress : undefined
  ) as Address | undefined;
  const publicClient = usePublicClient({ chainId: supportedChain.id });

  const [state, setState] = useState<LoadState>(
    contractAddress ? "loading" : "unconfigured",
  );
  const [editions, setEditions] = useState<CharityEdition[]>([]);
  const [unitPriceWei, setUnitPriceWei] = useState<bigint>();
  const [editionsPerArtwork, setEditionsPerArtwork] = useState<bigint>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!contractAddress || !publicClient) return;
    setState("loading");
    try {
      const contract = { abi: charityEditionsAbi, address: contractAddress };
      const [seriesCount, perArtwork, priceWei] = await Promise.all([
        publicClient.readContract({ ...contract, functionName: "seriesCount" }),
        publicClient.readContract({
          ...contract,
          functionName: "EDITIONS_PER_ARTWORK",
        }),
        publicClient.readContract({
          ...contract,
          functionName: "PRIMARY_PRICE_WEI",
        }),
      ]);

      // Token IDs are assigned sequentially from 1 by `createSeries`, so the count enumerates them.
      const tokenIds = Array.from({ length: Number(seriesCount) }, (_, index) =>
        BigInt(index + 1),
      );
      const loaded = await Promise.all(
        tokenIds.map(async (tokenId) => {
          const series = (await publicClient.readContract({
            ...contract,
            functionName: "series",
            args: [tokenId],
          })) as unknown as SeriesTuple;
          const [mintedUnits, distributorUnits] = await Promise.all([
            publicClient.readContract({
              ...contract,
              functionName: "totalSupply",
              args: [tokenId],
            }),
            publicClient.readContract({
              ...contract,
              functionName: "balanceOf",
              args: [series.distributionWallet, tokenId],
            }),
          ]);
          return {
            tokenId: tokenId.toString(),
            artworkId: series.artworkId,
            distributionWallet: series.distributionWallet,
            mintedUnits: mintedUnits as bigint,
            distributorUnits: distributorUnits as bigint,
            soldOutAt: Number(series.soldOutAt),
            physicalDonationRecordedAt: Number(
              series.physicalDonationRecordedAt,
            ),
          } satisfies CharityEdition;
        }),
      );

      setEditionsPerArtwork(perArtwork as bigint);
      setUnitPriceWei(priceWei as bigint);
      setEditions(loaded);
      setError(undefined);
      setState("ready");
    } catch (reason) {
      setEditions([]);
      setError(
        reason instanceof Error
          ? reason.message
          : "The charity editions contract could not be read.",
      );
      setState("error");
    }
  }, [contractAddress, publicClient]);

  // `contractAddress` comes from the build-time environment and never changes at runtime, so the
  // unconfigured case is already the initial state and the effect only has to handle the read.
  useEffect(() => {
    if (!contractAddress) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [contractAddress, load]);

  return (
    <section className="charity-catalog">
      <CharityEditionRightsNotice className="charity-rights-notice" />

      <section
        aria-label="Charity edition terms"
        className="contract-facts"
        data-testid="charity-edition-terms"
      >
        <div>
          <span>Units per edition</span>
          <strong>
            {editionsPerArtwork ? editionsPerArtwork.toString() : "—"}
          </strong>
        </div>
        <div>
          <span>Recorded primary unit price</span>
          <strong>
            {unitPriceWei ? `${formatEther(unitPriceWei)} ETH` : "—"}
          </strong>
        </div>
        <div>
          <span>Artwork preview</span>
          <strong>Not provided</strong>
        </div>
        <div>
          <span>Settlement by ArtFi</span>
          <strong>None</strong>
        </div>
      </section>

      {state === "unconfigured" && (
        <div className="market-runtime-state" role="alert">
          <strong>Charity editions unavailable</strong>
          <span>
            No editions contract is configured for this environment. No fixture
            is shown as live data.
          </span>
        </div>
      )}

      {state === "loading" && (
        <div className="market-runtime-state" role="status">
          <strong>Reading editions from {supportedChain.name}</strong>
          <span>Every figure below is read from the contract.</span>
        </div>
      )}

      {state === "error" && (
        <div className="market-runtime-state" role="alert">
          <strong>Charity editions unavailable</strong>
          <span>{error}</span>
          <span>No fixture is shown as live data.</span>
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {state === "ready" && editions.length === 0 && (
        <div className="market-runtime-state" role="status">
          <strong>No editions created yet</strong>
          <span>
            The contract is readable and reports no series. This is the
            contract&apos;s state, not a placeholder.
          </span>
        </div>
      )}

      {state === "ready" && editions.length > 0 && (
        <ul className="charity-edition-grid">
          {editions.map((edition) => (
            <li className="charity-edition-card" key={edition.tokenId}>
              <p className="approved-eyebrow">Edition #{edition.tokenId}</p>
              <h3>
                <Link href={`/charity/${edition.tokenId}`}>
                  Charity edition {edition.tokenId}
                </Link>
              </h3>
              <p>{editionAvailability(edition)}</p>
              <dl>
                <div>
                  <dt>Units minted</dt>
                  <dd>{edition.mintedUnits.toString()}</dd>
                </div>
                <div>
                  <dt>Physical donation</dt>
                  <dd>
                    {edition.physicalDonationRecordedAt > 0
                      ? "Recorded"
                      : "Not recorded"}
                  </dd>
                </div>
              </dl>
              <Link className="secondary" href={`/charity/${edition.tokenId}`}>
                Edition details and holder access
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
