"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { supportedChain } from "@/lib/wagmi";
import { readAuctionHistoryPage, type AuctionHistoryFailure, type AuctionHistoryPage } from "@/lib/auction-history-pages";
import { createAuctionHistoryPager } from "@/lib/auction-history-pager";
import styles from "./auction-history-browser.module.css";

const eventOptions = [
  ["all", "All events"],
  ["ListingCreated", "Auction created"],
  ["BidPlaced", "Bids"],
  ["AuctionExtended", "Extensions"],
  ["ListingSettled", "Settlement"],
  ["ListingCancelled", "Cancellation"],
] as const;
const failureText: Record<AuctionHistoryFailure, string> = {
  INVALID_QUERY: "The auction or block-page size is invalid.",
  INVALID_CURSOR: "This navigation cursor does not match the current auction. Read the newest page.",
  UNAVAILABLE: "Auction history is unavailable. An unavailable response is not an empty history.",
  SOURCE_CHANGED: "The chain or a source block changed. Read the newest page to start a fresh history snapshot.",
  DENSE_RANGE: "This range is too dense to verify as one page. Choose fewer blocks and read the newest page.",
  MALFORMED: "The history response could not be verified. No partial history is shown.",
  CANCELLED: "The history read was cancelled. No late response is restored.",
};
const rowsPerPage = 50;

/** A public read workspace; no connection, signing, storage or transaction. */
export function AuctionHistoryBrowser({ market, listingId }: { market: Address; listingId: string }) {
  const client = usePublicClient({ chainId: supportedChain.id });
  const [span, setSpan] = useState(1000);
  const pager = useMemo(() => createAuctionHistoryPager(async (cursor, signal) => {
    if (!client) throw new Error("Configured reader unavailable");
    return readAuctionHistoryPage(client, market, listingId, { cursor, signal, blockSpan: span });
  }), [client, market, listingId, span]);
  const state = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getServerSnapshot);
  const [filter, setFilter] = useState("all"), [query, setQuery] = useState(""), [order, setOrder] = useState("newest");
  const [position, setPosition] = useState<{ page: AuctionHistoryPage | null; row: number }>({ page: null, row: 0 });
  useEffect(() => {
    const update = () => pager.setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); pager.setVisible(false); };
  }, [pager]);
  const page = state.phase === "ready" ? state.page : null;
  const selected = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...(page?.entries ?? [])].filter((entry) => (filter === "all" || entry.event === filter) && (!needle || [entry.transactionHash, entry.actor ?? "", entry.requestId ?? ""].some((value) => value.toLowerCase().includes(needle)))).sort((left, right) => {
      const newest = left.blockNumber === right.blockNumber ? right.logIndex - left.logIndex : left.blockNumber > right.blockNumber ? -1 : 1;
      return order === "oldest" ? -newest : newest;
    });
  }, [page, filter, query, order]);
  const row = position.page === page ? Math.min(position.row, Math.max(0, Math.ceil(selected.length / rowsPerPage) - 1)) : 0;
  const displayed = selected.slice(row * rowsPerPage, (row + 1) * rowsPerPage);
  const blocked = !client || state.pending || state.phase === "paused";
  const resetRows = () => setPosition({ page, row: 0 });
  return (
    <section className={styles.workspace} aria-label="Auction history browser" aria-busy={state.pending}>
      <h4>Browse earlier auction history</h4>
      <p>Read-only public events. Each navigation page retains one source-block snapshot; bidding and settlement use their separate current-state checks.</p>
      <div className={styles.controls}>
        <label>Blocks per page
          <select value={span} disabled={state.pending} onChange={(event) => {
            const value = Number(event.target.value);
            if ([10, 100, 1000, 10000].includes(value)) { setSpan(value); setPosition({ page: null, row: 0 }); }
          }}>
            {[10, 100, 1000, 10000].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" disabled={blocked} onClick={() => void pager.newest()}>Read newest page</button>
        <button type="button" disabled={blocked || !page?.older} onClick={() => void pager.older()}>Older blocks</button>
        <button type="button" disabled={blocked || !page?.newer} onClick={() => void pager.newer()}>Newer blocks</button>
        {state.phase === "unavailable" && <button type="button" disabled={blocked} onClick={() => void pager.retry()}>Retry read</button>}
      </div>
      <p role="status" aria-live="polite">
        {state.phase === "idle" && "Choose Read newest page to inspect auction history."}
        {state.phase === "loading" && "Reading and verifying this history page."}
        {state.phase === "paused" && "Auction history is paused and cleared while this page is hidden."}
        {state.phase === "unavailable" && failureText[state.failure ?? "UNAVAILABLE"]}
        {state.phase === "ready" && "This page is verified against the configured source response and canonical block headers."}
      </p>
      {!client && <p>The configured auction reader is unavailable.</p>}
      {page && <>
        <dl className={styles.provenance}>
          <dt>Chain / auction</dt><dd data-no-translate>{page.chainId} / {page.listingId}</dd>
          <dt>Source contract</dt><dd data-no-translate><code>{page.market}</code></dd>
          <dt>Snapshot block</dt><dd data-no-translate>{page.anchorBlock.toString()} · <code>{page.anchorHash}</code></dd>
          <dt>Covered blocks</dt><dd data-no-translate>{page.fromBlock.toString()}–{page.toBlock.toString()}</dd>
        </dl>
        <p>{page.entries.length} events returned for this range. New blocks are excluded until you read the newest page.{page.older ? " Earlier blocks remain available." : " This page reaches block zero."}</p>
        <div className={styles.controls}>
          <label>Event type within this page
            <select value={filter} onChange={(event) => { if (eventOptions.some(([value]) => value === event.target.value)) { setFilter(event.target.value); resetRows(); } }}>
              {eventOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Actor, transaction or request within this page
            <input value={query} maxLength={80} onChange={(event) => { setQuery(event.target.value); resetRows(); }} />
          </label>
          <label>Order within this page
            <select value={order} onChange={(event) => { if (["newest", "oldest"].includes(event.target.value)) { setOrder(event.target.value); resetRows(); } }}>
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
            </select>
          </label>
        </div>
        {selected.length ? <>
          <p>Rows {row * rowsPerPage + 1}–{Math.min((row + 1) * rowsPerPage, selected.length)} of {selected.length} matching events in these blocks.</p>
          <ol className={styles.events}>
            {displayed.map((entry) => <li key={entry.sourceKey}>
              <strong>{eventOptions.find(([value]) => value === entry.event)?.[1] ?? entry.event}</strong>
              <dl>
                <dt>Block / log index</dt><dd data-no-translate>{entry.blockNumber.toString()} / {entry.logIndex}</dd>
                <dt>Transaction</dt><dd data-no-translate><code>{entry.transactionHash}</code></dd>
                <dt>Block hash</dt><dd data-no-translate><code>{entry.blockHash}</code></dd>
                {entry.actor && <><dt>Actor</dt><dd data-no-translate><code>{entry.actor}</code></dd></>}
                {entry.amount !== undefined && <><dt>Amount in token base units</dt><dd data-no-translate>{entry.amount}</dd></>}
                {entry.requestId && <><dt>Creation request</dt><dd data-no-translate><code>{entry.requestId}</code></dd></>}
                {entry.previousEnd !== undefined && <><dt>Previous / extended end (Unix seconds)</dt><dd data-no-translate>{entry.previousEnd} / {entry.extendedEnd}</dd></>}
              </dl>
            </li>)}
          </ol>
          <div className={styles.controls}>
            <button type="button" disabled={row === 0} onClick={() => setPosition({ page, row: row - 1 })}>Previous rows</button>
            <button type="button" disabled={(row + 1) * rowsPerPage >= selected.length} onClick={() => setPosition({ page, row: row + 1 })}>Next rows</button>
          </div>
        </> : <p>{page.entries.length ? "No events match the current page filters. Earlier and newer blocks are separate pages." : "No auction events were returned for these covered blocks. This does not describe blocks outside this page."}</p>}
      </>}
    </section>
  );
}
