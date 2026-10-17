"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePublicClient } from "wagmi";
import { isAddress, type Address } from "viem";
import { supportedChain } from "@/lib/wagmi";
import {
  createPublicBlockHistoryPager,
  type PublicHistoryFailure,
} from "@/lib/public-block-history-pager";
import {
  readAuctionDiscoveryPage,
  type AuctionDiscoveryPage,
} from "@/lib/auction-discovery-pages";
import type { AuctionDiscoveryCursor } from "@/lib/auction-discovery-model";
import styles from "./auction-history-browser.module.css";

const errors: Record<PublicHistoryFailure, string> = {
  INVALID_QUERY:
    "Enter a valid public seller address and choose bounded page sizes.",
  INVALID_CURSOR:
    "The cursor belongs to another source or filter. Read the newest page.",
  UNAVAILABLE:
    "Auction discovery is unavailable. No successful or empty result is substituted.",
  SOURCE_CHANGED:
    "The source changed during this snapshot. Read the newest page to reconcile.",
  DENSE_RANGE:
    "This RPC range is too dense to verify. Select fewer blocks and read again.",
  MALFORMED:
    "The creation events or anchored listing details could not be verified.",
  CANCELLED: "Discovery was cancelled. Late results are not restored.",
};

/** Public listing discovery only. Selection delegates to the workbench's fresh
 * inspection path; none of these historical rows grants trading authority. */
export function AuctionDiscoveryBrowser({
  market,
  onInspect,
  disabled = false,
}: {
  market: Address;
  onInspect: (id: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const client = usePublicClient({ chainId: supportedChain.id });
  const [draftSeller, setDraftSeller] = useState(""),
    [draftSpan, setDraftSpan] = useState(1000),
    [draftSize, setDraftSize] = useState(25);
  const [query, setQuery] = useState<{
    seller: Address | null;
    span: number;
    size: number;
    request: number;
  }>({ seller: null, span: 1000, size: 25, request: 0 });
  const [formProblem, setFormProblem] = useState(""),
    [selecting, setSelecting] = useState(false),
    [selectionProblem, setSelectionProblem] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const pager = useMemo(
    () =>
      createPublicBlockHistoryPager<
        AuctionDiscoveryCursor,
        AuctionDiscoveryPage
      >(async (cursor, signal) => {
        if (!client) throw new Error("Configured auction reader unavailable");
        return readAuctionDiscoveryPage(client, market, {
          cursor,
          signal,
          seller: query.seller,
          blockSpan: query.span,
          pageSize: query.size,
        });
      }),
    [client, market, query.seller, query.span, query.size],
  );
  const state = useSyncExternalStore(
    pager.subscribe,
    pager.getSnapshot,
    pager.getServerSnapshot,
  );
  useEffect(() => {
    const update = () =>
      pager.setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      pager.setVisible(false);
    };
  }, [pager]);
  useEffect(() => {
    if (query.request > 0) void pager.newest();
  }, [pager, query.request]);
  const page = state.phase === "ready" ? state.page : null;
  const busy = state.pending || selecting || state.phase === "paused";
  const shown =
    page?.listings.filter(
      (listing) => stateFilter === "all" || listing.state === stateFilter,
    ) ?? [];
  return (
    <section
      className={styles.workspace}
      aria-label="Auction listing discovery"
      aria-busy={state.pending}
    >
      <h3>Discover earlier auction listings</h3>
      <p>
        Public creation records are paged from one source snapshot. Opening a
        result loads current approved-source terms; a historical listing is not
        permission to bid or settle.
      </p>
      <form
        className={styles.controls}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !client) return;
          const value = draftSeller.trim();
          if (value && (!isAddress(value) || /^0x0+$/i.test(value))) {
            setFormProblem(
              "Enter a valid public seller address or leave the field empty for all sellers.",
            );
            return;
          }
          setFormProblem("");
          setSelectionProblem("");
          setQuery((old) => ({
            seller: value ? (value.toLowerCase() as Address) : null,
            span: draftSpan,
            size: draftSize,
            request: old.request + 1,
          }));
        }}
      >
        <label>
          Public listing seller (optional)
          <input
            value={draftSeller}
            maxLength={42}
            disabled={busy}
            onChange={(event) => setDraftSeller(event.target.value)}
          />
        </label>
        <label>
          Blocks per source window
          <select
            value={draftSpan}
            disabled={busy}
            onChange={(event) => {
              const value = Number(event.target.value);
              if ([10, 100, 1000, 10000].includes(value)) setDraftSpan(value);
            }}
          >
            {[10, 100, 1000, 10000].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Listing records per page
          <select
            value={draftSize}
            disabled={busy}
            onChange={(event) => {
              const value = Number(event.target.value);
              if ([10, 25, 50].includes(value)) setDraftSize(value);
            }}
          >
            {[10, 25, 50].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || !client}>
          Read auction listings
        </button>
      </form>
      {formProblem && <p role="alert">{formProblem}</p>}
      <div className={styles.controls}>
        <button
          type="button"
          disabled={busy || !client || query.request === 0}
          onClick={() => void pager.newest()}
        >
          Newest listings page
        </button>
        <button
          type="button"
          disabled={busy || !page?.older}
          onClick={() => void pager.older()}
        >
          Older listing records
        </button>
        <button
          type="button"
          disabled={busy || !page?.newer}
          onClick={() => void pager.newer()}
        >
          Newer listing records
        </button>
        {state.phase === "unavailable" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void pager.retry()}
          >
            Retry discovery read
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {state.phase === "idle" &&
          "Choose public filters and read listings. Discovery does not connect or sign with a wallet."}
        {state.phase === "loading" &&
          "Verifying creation records and listing types at the snapshot block."}
        {state.phase === "paused" &&
          "Discovery is cleared while this page is hidden."}
        {state.phase === "unavailable" &&
          errors[state.failure ?? "UNAVAILABLE"]}
        {state.phase === "ready" &&
          "The current discovery page is attributed to the source shown below."}
      </p>
      {!client && <p>The configured auction reader is unavailable.</p>}
      {page && (
        <>
          <dl className={styles.provenance}>
            <dt>Source / chain</dt>
            <dd data-no-translate>
              <code>{page.market}</code> / {page.chainId}
            </dd>
            <dt>Snapshot</dt>
            <dd data-no-translate>
              {page.anchorBlock.toString()} / <code>{page.anchorHash}</code>
            </dd>
            <dt>Covered blocks</dt>
            <dd data-no-translate>
              {page.fromBlock.toString()}–{page.toBlock.toString()}
            </dd>
            <dt>Applied public seller filter</dt>
            <dd>
              {page.seller ? (
                <code data-no-translate>{page.seller}</code>
              ) : (
                "All public sellers"
              )}
            </dd>
          </dl>
          <p>
            Examined {page.checkedCandidates} creation records in this page;{" "}
            {page.nonAuctionCount} non-auction records were excluded by the
            anchored contract type. More records can remain within these blocks
            or in other windows.
          </p>
          <label>
            Contract state within this page
            <select
              value={stateFilter}
              onChange={(event) => {
                if (
                  ["all", "active", "settled", "cancelled"].includes(
                    event.target.value,
                  )
                )
                  setStateFilter(event.target.value);
              }}
            >
              <option value="all">All auction states</option>
              <option value="active">Active contract state</option>
              <option value="settled">Settled</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          {shown.length ? (
            <ol className={styles.events}>
              {shown.map((listing) => (
                <li key={`${listing.transactionHash}:${listing.logIndex}`}>
                  <h4>Auction {listing.listingId}</h4>
                  <dl>
                    <dt>Contract state at snapshot</dt>
                    <dd>
                      {listing.state === "active"
                        ? "Active"
                        : listing.state === "settled"
                          ? "Settled"
                          : "Cancelled"}
                    </dd>
                    <dt>Public seller</dt>
                    <dd data-no-translate>
                      <code>{listing.seller}</code>
                    </dd>
                    <dt>Fraction / payment contract</dt>
                    <dd data-no-translate>
                      <code>{listing.asset}</code> /{" "}
                      <code>{listing.payment}</code>
                    </dd>
                    <dt>Remaining fraction / opening bid (token base units)</dt>
                    <dd data-no-translate>
                      {listing.amountRemaining} / {listing.openingBid}
                    </dd>
                    <dt>Start / end (Unix seconds)</dt>
                    <dd data-no-translate>
                      {listing.startsAt} / {listing.endsAt}
                    </dd>
                    <dt>Creation block / log index</dt>
                    <dd data-no-translate>
                      {listing.blockNumber.toString()} / {listing.logIndex}
                    </dd>
                    <dt>Creation transaction</dt>
                    <dd data-no-translate>
                      <code>{listing.transactionHash}</code>
                    </dd>
                    <dt>Creation block hash</dt>
                    <dd data-no-translate>
                      <code>{listing.blockHash}</code>
                    </dd>
                    <dt>Creation request</dt>
                    <dd data-no-translate>
                      <code>{listing.requestId}</code>
                    </dd>
                  </dl>
                  <button
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => {
                      if (disabled || busy) return;
                      setSelecting(true);
                      setSelectionProblem("");
                      void Promise.resolve()
                        .then(() => onInspect(listing.listingId))
                        .catch(() =>
                          setSelectionProblem(
                            "Current auction inspection was unavailable. No wallet action was requested.",
                          ),
                        )
                        .finally(() => setSelecting(false));
                    }}
                  >
                    Open current auction {listing.listingId}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {page.listings.length
                ? "No discovered auction matches this page's state filter. Other pages are separate results."
                : page.checkedCandidates
                  ? "These creation records contain no verified auction type. Other records and blocks may still contain auctions."
                  : "No creation records were returned for this source window. This does not describe other blocks."}
            </p>
          )}
          {selectionProblem && <p role="alert">{selectionProblem}</p>}
        </>
      )}
    </section>
  );
}
