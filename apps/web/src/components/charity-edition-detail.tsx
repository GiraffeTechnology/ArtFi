"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatEther, isAddress, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";

import { charityEditionsAbi } from "@/lib/contracts";
import { supportedChain } from "@/lib/wagmi";

import { CharityEditionRightsNotice } from "./charity-edition-rights-notice";
import { CharityHolderAccess } from "./charity-holder-access";

/**
 * One charity edition — #110 §2 CH.1 to CH.9.
 *
 * The page a buyer or holder actually lands on. Three rules shape it:
 *
 *   - **CH.8 travels with the edition.** The rights notice renders before anything else, because
 *     `ACCEPTANCE.md` §7.17 fails an audit where an edition is displayed or offered without it.
 *   - **CH.7 leaves a hole.** There is no artwork image here and no element that could hold one.
 *     A missing preview is the correct appearance, not a defect to fix.
 *   - **Every number is read from the chain.** An unreadable contract produces an unavailable
 *     state, never a plausible-looking edition.
 */

type EditionView = {
  tokenId: string;
  artworkId: Hex;
  metadataHash: Hex;
  distributionWallet: Address;
  createdAt: number;
  soldOutAt: number;
  physicalDonationRecordedAt: number;
  mintedUnits: bigint;
  distributorUnits: bigint;
  unitPriceWei: bigint;
};

type SeriesTuple = {
  artworkId: Hex;
  masterArtworkHash: Hex;
  metadataHash: Hex;
  distributionWallet: Address;
  createdAt: bigint;
  soldOutAt: bigint;
  physicalDonationRecordedAt: bigint;
};

type LoadState = "loading" | "ready" | "unconfigured" | "error";

function timestamp(value: number): string {
  return value > 0 ? new Date(value * 1000).toISOString() : "Not recorded";
}

export function CharityEditionDetail({ tokenId }: { tokenId: string }) {
  const configuredAddress =
    process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS;
  const contractAddress = (
    isAddress(configuredAddress ?? "") ? configuredAddress : undefined
  ) as Address | undefined;
  const publicClient = usePublicClient({ chainId: supportedChain.id });

  const [state, setState] = useState<LoadState>(
    contractAddress ? "loading" : "unconfigured",
  );
  const [edition, setEdition] = useState<EditionView>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!contractAddress || !publicClient) return;
    setState("loading");
    try {
      const contract = { abi: charityEditionsAbi, address: contractAddress };
      const id = BigInt(tokenId);
      const series = (await publicClient.readContract({
        ...contract,
        functionName: "series",
        args: [id],
      })) as unknown as SeriesTuple;
      const [mintedUnits, distributorUnits, unitPriceWei] = await Promise.all([
        publicClient.readContract({
          ...contract,
          functionName: "totalSupply",
          args: [id],
        }),
        publicClient.readContract({
          ...contract,
          functionName: "balanceOf",
          args: [series.distributionWallet, id],
        }),
        publicClient.readContract({
          ...contract,
          functionName: "PRIMARY_PRICE_WEI",
        }),
      ]);

      setEdition({
        tokenId,
        artworkId: series.artworkId,
        metadataHash: series.metadataHash,
        distributionWallet: series.distributionWallet,
        createdAt: Number(series.createdAt),
        soldOutAt: Number(series.soldOutAt),
        physicalDonationRecordedAt: Number(series.physicalDonationRecordedAt),
        mintedUnits: mintedUnits as bigint,
        distributorUnits: distributorUnits as bigint,
        unitPriceWei: unitPriceWei as bigint,
      });
      setError(undefined);
      setState("ready");
    } catch (reason) {
      setEdition(undefined);
      setError(
        reason instanceof Error
          ? reason.message
          : "This charity edition could not be read from the contract.",
      );
      setState("error");
    }
  }, [contractAddress, publicClient, tokenId]);

  // `contractAddress` comes from the build-time environment and never changes at runtime, so the
  // unconfigured case is already the initial state and the effect only has to handle the read.
  useEffect(() => {
    if (!contractAddress) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [contractAddress, load]);

  return (
    <section className="charity-detail">
      <CharityEditionRightsNotice className="charity-rights-notice" />

      {state === "unconfigured" && (
        <div className="market-runtime-state" role="alert">
          <strong>Edition unavailable</strong>
          <span>
            No editions contract is configured for this environment. No fixture
            is shown as live data.
          </span>
        </div>
      )}

      {state === "loading" && (
        <div className="market-runtime-state" role="status">
          <strong>Reading edition {tokenId}</strong>
          <span>from {supportedChain.name}.</span>
        </div>
      )}

      {state === "error" && (
        <div className="market-runtime-state" role="alert">
          <strong>Edition unavailable</strong>
          <span>{error}</span>
          <button className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {state === "ready" && edition && (
        <>
          <section
            aria-label="Charity edition facts"
            className="contract-facts"
            data-testid="charity-edition-facts"
          >
            <div>
              <span>Units minted</span>
              <strong>{edition.mintedUnits.toString()}</strong>
            </div>
            <div>
              <span>Held by the distribution wallet</span>
              <strong>{edition.distributorUnits.toString()}</strong>
            </div>
            <div>
              <span>Recorded primary unit price</span>
              <strong>{formatEther(edition.unitPriceWei)} ETH</strong>
            </div>
            <div>
              <span>Artwork preview</span>
              <strong>Not provided</strong>
            </div>
            <div>
              <span>Sellout recorded</span>
              <strong>{timestamp(edition.soldOutAt)}</strong>
            </div>
            <div>
              <span>Physical donation recorded</span>
              <strong>{timestamp(edition.physicalDonationRecordedAt)}</strong>
            </div>
            <div>
              <span>Series created</span>
              <strong>{timestamp(edition.createdAt)}</strong>
            </div>
            <div>
              <span>Metadata hash</span>
              <strong className="charity-digest" data-no-translate>
                {edition.metadataHash}
              </strong>
            </div>
          </section>

          <p className="charity-detail__settlement">
            ArtFi creates, signs, matches, fulfils and settles no order for this
            edition. Primary proceeds are designated for CCHS.
          </p>

          <CharityHolderAccess tokenId={edition.tokenId} />
        </>
      )}

      <p>
        <Link className="text-link" href="/charity">
          All charity editions
        </Link>
      </p>
    </section>
  );
}
