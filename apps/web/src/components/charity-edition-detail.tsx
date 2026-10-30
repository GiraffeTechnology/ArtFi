"use client";

import { publicSetting } from "@/lib/public-runtime-config";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, isAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";

import {
  readCharityEditionFacts,
  type CharityEditionFacts,
} from "@/lib/charity-edition-facts";
import { supportedChain } from "@/lib/wagmi";

import { CharityEditionRightsNotice } from "./charity-edition-rights-notice";
import { CharityHolderAccess } from "./charity-holder-access";
import { CharityVenueLink } from "./charity-venue-link";
import { CharityEvidenceRecorder } from "./charity-evidence-recorder";

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

type LoadState = "loading" | "ready" | "unconfigured" | "error";

function timestamp(value: number): string {
  return value > 0 ? new Date(value * 1000).toISOString() : "Not recorded";
}

export function CharityEditionDetail({ tokenId }: { tokenId: string }) {
  const configuredAddress = publicSetting(
    "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  );
  const contractAddress = (
    isAddress(configuredAddress ?? "") ? configuredAddress : undefined
  ) as Address | undefined;
  const publicClient = usePublicClient({ chainId: supportedChain.id });

  const context = `${tokenId}:${contractAddress?.toLowerCase() ?? "unconfigured"}:${publicClient?.uid ?? "no-reader"}`;
  const [reading, setReading] = useState<{
    context: string;
    state: LoadState;
    edition?: CharityEditionFacts;
  }>({ context, state: contractAddress ? "loading" : "unconfigured" });
  const request = useRef<AbortController | null>(null);
  // Do not display a previous edition even before effect cleanup runs for new props.
  const state: LoadState =
    reading.context === context
      ? reading.state
      : !contractAddress
        ? "unconfigured"
        : publicClient
          ? "loading"
          : "error";
  const edition =
    reading.context === context && state === "ready"
      ? reading.edition
      : undefined;

  const load = useCallback(async () => {
    request.current?.abort();
    request.current = null;
    if (!contractAddress || !publicClient) {
      setReading({
        context,
        state: contractAddress ? "error" : "unconfigured",
      });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      request.current === controller && !controller.signal.aborted;
    setReading({ context, state: "loading" });
    try {
      const facts = await readCharityEditionFacts({
        client: publicClient,
        contractAddress,
        tokenId,
        expectedChainId: supportedChain.id,
        signal: controller.signal,
        isCurrent: current,
      });
      if (current()) setReading({ context, state: "ready", edition: facts });
    } catch {
      if (current()) setReading({ context, state: "error" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [context, contractAddress, publicClient, tokenId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

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
        <div
          className="market-runtime-state"
          role="alert"
          data-testid="charity-edition-read-error"
        >
          <strong>Edition unavailable</strong>
          <span>This charity edition could not be read. Please retry.</span>
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
            Use the native NFT marketplace for configured supported collections.
            Hoodi charity editions are not represented as live OpenSea orders.
            Primary proceeds are designated for CCHS.
          </p>

          <CharityVenueLink tokenId={edition.tokenId} />

          <CharityHolderAccess tokenId={edition.tokenId} />
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
          >
            Refresh edition facts
          </button>
          <CharityEvidenceRecorder tokenId={edition.tokenId} />
        </>
      )}

      {/*
        The observed source record remains independent of the edition's contract read.
      */}
      {!edition && <CharityVenueLink tokenId={tokenId} />}

      <p>
        <Link className="text-link" href="/charity">
          All charity editions
        </Link>
      </p>
    </section>
  );
}
