"use client";

import { useState } from "react";
import type { NftOperationHistory } from "@/lib/nft/model";
import {
  filterNftHistoryPage,
  nftHistoryActions,
  nftHistoryMeaning,
  nftHistoryStatuses,
} from "@/lib/nft/history-view";

export function NftHistoryResults({
  history,
  busy,
  onRecover,
  onPage,
}: {
  history: NftOperationHistory;
  busy: boolean;
  onRecover: (id: string) => void;
  onPage: (page: number) => void;
}) {
  const [action, setAction] = useState("all"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState("");
  const rows = filterNftHistoryPage(history, { action, status, query });
  return (
    <div role="region" aria-label="Recorded NFT operation results">
      <p>
        Recorded for wallet <span data-no-translate>{history.wallet}</span> on
        chain <span data-no-translate>{history.chainId}</span>. These are ArtFi
        journal records, not a live holdings or order-availability query.
      </p>
      <form
        className="market-filters"
        aria-label="Filter current NFT history page"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Action on this page
          <select
            value={action}
            onChange={(event) => setAction(event.currentTarget.value)}
          >
            <option value="all">All actions</option>
            {nftHistoryActions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recorded status on this page
          <select
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
          >
            <option value="all">All recorded statuses</option>
            {nftHistoryStatuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Find on this page
          <input
            type="search"
            data-no-translate
            value={query}
            maxLength={200}
            spellCheck={false}
            placeholder="Operation, collection, token or hash"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setAction("all");
            setStatus("all");
            setQuery("");
          }}
        >
          Clear page filters
        </button>
      </form>
      <p role="status">
        {rows.length} shown from {history.data.length} records on page{" "}
        {history.page}. Filters apply to this loaded page only and reset when
        another page is loaded.
      </p>
      {!history.data.length ? (
        <p>No recorded NFT operation is present on this page.</p>
      ) : !rows.length ? (
        <p>
          No records on this page match these filters. Other history pages have
          not been searched.
        </p>
      ) : (
        <ol>
          {rows.map((item) => (
            <li key={item.id} className="nft-market-card">
              <h4>
                {item.action} · <span data-no-translate>{item.collection}</span>{" "}
                · token <span data-no-translate>{item.tokenId}</span>
              </h4>
              <p>Recorded status: {item.status}</p>
              <p>{nftHistoryMeaning(item)}</p>
              <dl>
                <div>
                  <dt>Operation</dt>
                  <dd className="nft-market-hash" data-no-translate>
                    {item.id}
                  </dd>
                </div>
                <div>
                  <dt>Step kind</dt>
                  <dd>{item.kind}</dd>
                </div>
                <div>
                  <dt>Wallet attempt recorded</dt>
                  <dd>
                    {item.walletStarted
                      ? "Yes; reconcile its result before another attempt."
                      : "No wallet-start marker recorded."}
                  </dd>
                </div>
                <div>
                  <dt>Recorded update</dt>
                  <dd>
                    <time dateTime={item.updatedAt} data-no-translate>
                      {item.updatedAt}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Transaction reference</dt>
                  <dd className="nft-market-hash" data-no-translate>
                    {item.transactionHash ?? "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Venue order reference</dt>
                  <dd className="nft-market-hash" data-no-translate>
                    {item.orderHash ?? "Not recorded"}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRecover(item.id)}
              >
                Recover this NFT operation
              </button>
            </li>
          ))}
        </ol>
      )}
      <nav
        className="market-pagination"
        aria-label="Private NFT operation pages"
      >
        <button
          type="button"
          disabled={busy || history.page === 1}
          onClick={() => onPage(history.page - 1)}
        >
          Previous NFT operations
        </button>
        <span>Page {history.page}</span>
        <button
          type="button"
          disabled={busy || !history.hasMore}
          onClick={() => onPage(history.page + 1)}
        >
          Next NFT operations
        </button>
      </nav>
      <p>
        Recovery rechecks the original operation and its authority. Opening a
        history record does not confirm a wallet action or retry a transaction.
      </p>
    </div>
  );
}
