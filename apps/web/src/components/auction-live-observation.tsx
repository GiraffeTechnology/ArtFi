"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { supportedChain } from "@/lib/wagmi";
import {
  auctionCountdown,
  readAuctionObservation,
} from "@/lib/auction-observation";
import { createAuctionObserver } from "@/lib/auction-observer";

const labels = {
  idle: "A current auction observation has not been loaded.",
  loading: "Reading the current auction and its attributed events.",
  ready: "Auction state and history share the source block shown below.",
  unavailable:
    "The current auction observation is unavailable. Refresh to reconcile; no successful or empty result is substituted.",
  paused: "Live auction observation is paused while this page is hidden.",
};
function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** A public read model. This panel never supplies signing or execution authority. */
export function AuctionLiveObservation({
  market,
  listingId,
}: {
  market: Address;
  listingId: string;
}) {
  const client = usePublicClient({ chainId: supportedChain.id });
  const observer = useMemo(
    () =>
      createAuctionObserver(async () => {
        if (!client)
          throw new Error("The configured auction reader is unavailable.");
        return readAuctionObservation(client, market, listingId);
      }),
    [client, market, listingId],
  );
  const state = useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getServerSnapshot,
  );
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const update = () =>
      observer.setActive(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      // Pause is replayable under React StrictMode effect setup/cleanup.
      observer.setActive(false);
    };
  }, [observer]);
  useEffect(() => {
    if (state.phase !== "ready") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);
  const observed = state.value;
  const countdown =
    observed && state.observedAt !== null
      ? auctionCountdown(observed.snapshot, state.observedAt, clock)
      : null;
  return (
    <section
      aria-label="Live auction observation"
      aria-busy={state.phase === "loading"}
    >
      <h4>Live auction state and bid history</h4>
      <p role="status">{labels[state.phase]}</p>
      <button
        type="button"
        className="secondary"
        disabled={state.phase === "loading" || state.phase === "paused"}
        onClick={() => void observer.refresh()}
      >
        Refresh live observation
      </button>
      <p>
        Reads refresh after completion while this page is visible. This is a
        direct chain observation, not settlement confirmation or registry
        holdership.
      </p>
      {observed && (
        <>
          <dl className="contract-facts">
            <div>
              <dt>Current highest bid, payment base units</dt>
              <dd data-no-translate data-translation-skip>
                {observed.snapshot.highestBid.toString()}
              </dd>
            </div>
            <div>
              <dt>Current highest bidder</dt>
              <dd
                className="nft-market-hash"
                data-no-translate
                data-translation-skip
              >
                {observed.snapshot.highestBidder}
              </dd>
            </div>
            <div>
              <dt>Current state</dt>
              <dd>
                {observed.snapshot.state === 1
                  ? "Active"
                  : observed.snapshot.state === 2
                    ? "Settled"
                    : "Cancelled"}
                {observed.snapshot.paused ? " · New activity paused" : ""}
              </dd>
            </div>
            <div>
              <dt>Source block</dt>
              <dd data-no-translate data-translation-skip>
                {observed.snapshot.blockNumber.toString()} ·{" "}
                {observed.snapshot.blockHash}
              </dd>
            </div>
            <div>
              <dt>Chain observation time</dt>
              <dd data-no-translate data-translation-skip>
                {new Date(observed.snapshot.timestamp * 1000).toISOString()}
              </dd>
            </div>
            <div>
              <dt>Approximate countdown</dt>
              <dd>
                {countdown?.phase === "closed" ? (
                  "This auction is closed."
                ) : countdown?.phase === "starts" ? (
                  <>
                    Starts in{" "}
                    <span data-no-translate>{duration(countdown.seconds)}</span>
                  </>
                ) : countdown?.phase === "ends" ? (
                  countdown.seconds === 0 ? (
                    "Awaiting current chain state at the end boundary."
                  ) : (
                    <>
                      Ends in{" "}
                      <span data-no-translate>
                        {duration(countdown.seconds)}
                      </span>
                    </>
                  )
                ) : (
                  "Waiting for a fresh chain observation."
                )}
              </dd>
            </div>
          </dl>
          <p>
            The countdown is a display estimate. Every bid and settlement still
            checks current chain state before wallet approval. A late bid can
            extend the end time.
          </p>
          <p>
            History covers the last 10,000 blocks through the displayed source
            block. No event in this range does not mean no earlier auction
            history.
          </p>
          {observed.entries.length ? (
            <ol>
              {observed.entries.map((entry) => (
                <li key={entry.sourceKey} className="auction-field">
                  <strong>
                    {entry.event === "ListingCreated"
                      ? "Auction created"
                      : entry.event === "BidPlaced"
                        ? "Bid placed"
                        : entry.event === "AuctionExtended"
                          ? "Auction extended"
                          : entry.event === "ListingSettled"
                            ? "Auction settled"
                            : "Auction cancelled"}
                  </strong>
                  <dl className="contract-facts">
                    {entry.actor && (
                      <div>
                        <dt>Event account</dt>
                        <dd
                          className="nft-market-hash"
                          data-no-translate
                          data-translation-skip
                        >
                          {entry.actor}
                        </dd>
                      </div>
                    )}
                    {entry.amount !== undefined && (
                      <div>
                        <dt>Amount, payment base units</dt>
                        <dd data-no-translate data-translation-skip>
                          {entry.amount}
                        </dd>
                      </div>
                    )}
                    {entry.previousEnd && entry.extendedEnd && (
                      <div>
                        <dt>End extended from / to, Unix seconds</dt>
                        <dd data-no-translate data-translation-skip>
                          {entry.previousEnd} / {entry.extendedEnd}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Transaction / log</dt>
                      <dd
                        className="nft-market-hash"
                        data-no-translate
                        data-translation-skip
                      >
                        {entry.transactionHash} / {entry.logIndex}
                      </dd>
                    </div>
                    <div>
                      <dt>Event block</dt>
                      <dd
                        className="nft-market-hash"
                        data-no-translate
                        data-translation-skip
                      >
                        {entry.blockNumber.toString()} · {entry.blockHash}
                      </dd>
                    </div>
                    <div>
                      <dt>Full source identity</dt>
                      <dd
                        className="nft-market-hash"
                        data-no-translate
                        data-translation-skip
                      >
                        {entry.sourceKey}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <p>No auction event was observed in this exact block range.</p>
          )}
        </>
      )}
    </section>
  );
}
