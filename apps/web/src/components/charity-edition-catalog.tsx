"use client";

import { publicSetting } from "@/lib/public-runtime-config";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, isAddress, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";

import {
  readCharityCatalogPage,
  charityCatalogPageSize,
  type CharityCatalogPage,
} from "@/lib/charity-catalog-page";
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

  const [pageStart, setPageStart] = useState(1n);
  const context = `${contractAddress?.toLowerCase() ?? "unconfigured"}:${publicClient?.uid ?? "no-reader"}:${pageStart}`;
  const [reading, setReading] = useState<{
    context: string;
    state: LoadState;
    page?: CharityCatalogPage;
  }>({
    context,
    state: contractAddress ? "loading" : "unconfigured",
  });
  const request = useRef<AbortController | null>(null);
  const state: LoadState =
    reading.context === context
      ? reading.state
      : !contractAddress
        ? "unconfigured"
        : publicClient
          ? "loading"
          : "error";
  const page =
    reading.context === context && state === "ready" ? reading.page : undefined;
  const editions = page?.editions ?? [];
  const unitPriceWei = page?.unitPriceWei;
  const editionsPerArtwork = page?.editionsPerArtwork;
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
      const result = await readCharityCatalogPage({
        client: publicClient,
        contractAddress,
        expectedChainId: supportedChain.id,
        start: pageStart,
        signal: controller.signal,
        isCurrent: current,
      });
      if (current()) setReading({ context, state: "ready", page: result });
    } catch {
      if (current()) setReading({ context, state: "error" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [context, contractAddress, publicClient, pageStart]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

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
        <div
          className="market-runtime-state"
          role="alert"
          data-testid="charity-catalog-read-error"
        >
          <strong>Charity editions unavailable</strong>
          <span>The charity editions could not be read. Please retry.</span>
          <span>No fixture is shown as live data.</span>
          {pageStart > 1n && (
            <button className="secondary" onClick={() => setPageStart(1n)}>
              First editions
            </button>
          )}
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
      {page && page.seriesCount > 0n && (
        <nav
          aria-label="Charity edition pages"
          className="market-runtime-state"
        >
          <span>
            Showing editions {page.start.toString()}–
            {(page.start + BigInt(editions.length) - 1n).toString()} of{" "}
            {page.seriesCount.toString()}
          </span>
          <div>
            <button
              type="button"
              className="secondary"
              disabled={page.start === 1n}
              onClick={() => setPageStart(page.start - charityCatalogPageSize)}
            >
              Previous editions
            </button>
            <button
              type="button"
              className="secondary"
              disabled={page.start + BigInt(editions.length) > page.seriesCount}
              onClick={() => setPageStart(page.start + charityCatalogPageSize)}
            >
              Next editions
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
