"use client";

import { useId, useState } from "react";
import type { PortfolioEntry } from "@/lib/portfolio-records-state";
import { INITIAL_PORTFOLIO_HISTORY_FILTER, projectPortfolioHistory, type PortfolioHistoryFilter } from "@/lib/portfolio-history";

export function PortfolioHistory({ entries }: { entries: readonly PortfolioEntry[] }) {
  const controlId = useId();
  const [filter, setFilter] = useState<PortfolioHistoryFilter>({ ...INITIAL_PORTFOLIO_HISTORY_FILTER });
  let view;
  try {
    view = projectPortfolioHistory(entries, filter);
  } catch {
    return <><h3>Transaction history</h3><p role="alert">Indexed history is unavailable. Refresh indexed records to try again.</p></>;
  }
  const change = (value: Partial<PortfolioHistoryFilter>) => setFilter((previous) => ({ ...previous, ...value, page: 1 }));
  const eventNames = filter.eventName && !view.eventNames.includes(filter.eventName) ? [...view.eventNames, filter.eventName].sort() : view.eventNames;
  return (
    <>
      <h3>Transaction history</h3>
      <p>Filters and pages apply only to the loaded indexed records. They are not a complete wallet history. Refresh indexed records for newer observations.</p>
      <div>
        <label htmlFor={`${controlId}-status`}>History status</label>
        <select id={`${controlId}-status`} value={filter.status} onChange={(event) => change({ status: event.target.value as PortfolioHistoryFilter["status"] })}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="removed">Removed by reorg</option>
        </select>
        <label htmlFor={`${controlId}-event`}>History event</label>
        <select id={`${controlId}-event`} value={filter.eventName} onChange={(event) => change({ eventName: event.target.value })}>
          <option value="">All event types</option>
          {eventNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <label htmlFor={`${controlId}-order`}>History order</label>
        <select id={`${controlId}-order`} value={filter.direction} onChange={(event) => change({ direction: event.target.value as PortfolioHistoryFilter["direction"] })}>
          <option value="newest">Newest block first</option>
          <option value="oldest">Oldest block first</option>
        </select>
        <button type="button" onClick={() => setFilter({ ...INITIAL_PORTFOLIO_HISTORY_FILTER })}>Reset history filters</button>
      </div>
      <p role="status">Showing {view.first}–{view.last} of {view.totalMatching} matching loaded records ({view.totalLoaded} loaded).</p>
      {view.totalLoaded === 0 ? <p>No indexed transaction is associated with this address.</p> : view.totalMatching === 0 ? <p>No loaded records match these history filters.</p> : (
        <ol start={view.first}>
          {view.entries.map((transaction) => (
            <li key={transaction.id}>
              <strong>{transaction.eventName}</strong>
              <span>{transaction.status} · block {transaction.blockNumber} · log {transaction.logIndex}</span>
              <small>Transaction: {transaction.transactionHash}</small>
              <small>Contract: {transaction.contractAddress}</small>
              <small>Last indexed update: <time dateTime={transaction.observedAt}>{transaction.observedAt}</time></small>
              {transaction.status === "removed" ? <small>Removed from the canonical chain; any previous confirmation no longer applies.</small> : null}
            </li>
          ))}
        </ol>
      )}
      <nav aria-label="Loaded transaction history pages">
        <button type="button" disabled={view.page === 1} onClick={() => setFilter((previous) => ({ ...previous, page: view.page - 1 }))}>Previous history page</button>
        <span>Page {view.page} of {view.pages}</span>
        <button type="button" disabled={view.page === view.pages} onClick={() => setFilter((previous) => ({ ...previous, page: view.page + 1 }))}>Next history page</button>
      </nav>
    </>
  );
}
