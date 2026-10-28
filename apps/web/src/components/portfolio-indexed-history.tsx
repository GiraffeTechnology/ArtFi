"use client";

import {
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  createIndexedHistoryController,
  indexedHistoryPageLimit,
  initialIndexedHistoryFilter,
  snapshotIndexedHistoryFilter,
  type IndexedHistoryFilter,
  type IndexedHistoryPage,
  type IndexedHistoryState,
} from "@/lib/portfolio-indexed-history";

const serverState: IndexedHistoryState = Object.freeze({
  filter: initialIndexedHistoryFilter,
  status: "loading",
});

/** Mounted only inside the original authenticated wallet/session-keyed portfolio.
 * This view reads indexed observations; it never requests a signature or chain write. */
export function PortfolioIndexedHistory({ address }: { address: string }) {
  const id = useId();
  const [controller] = useState(() => createIndexedHistoryController(address));
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => serverState,
  );
  const [eventInput, setEventInput] = useState("");
  const [contractInput, setContractInput] = useState("");
  const [inputError, setInputError] = useState("");
  useEffect(() => {
    controller.activate();
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  const filter = state.filter;
  const page = state.page;
  const change = (next: IndexedHistoryFilter) => {
    setInputError("");
    void controller.change(next);
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = snapshotIndexedHistoryFilter({
        ...filter,
        eventName: eventInput.trim(),
        contractAddress: contractInput.trim(),
        page: 1,
      });
      change(next);
    } catch {
      setInputError(
        "Use the exact event name and a complete contract address, or leave those filters empty.",
      );
    }
  };
  return (
    <article
      className="portfolio-records"
      data-testid="portfolio-indexed-history"
      aria-labelledby={id}
      style={{ overflowWrap: "anywhere" }}
    >
      <div className="section-heading">
        <h3 id={id}>All indexed transaction history</h3>
        <button
          type="button"
          disabled={state.status === "loading"}
          onClick={() => void controller.refresh()}
        >
          Refresh all indexed history
        </button>
      </div>
      <p>
        Search this wallet&apos;s indexed activity on Hoodi, including records
        older than the recent portfolio snapshot. Filters apply to all matching
        indexed records.
      </p>
      <p>
        This index is not a complete blockchain scan or evidence of property
        rights. New activity and chain reorganizations can change totals and
        page contents. Refresh to check current indexed records.
      </p>
      <form
        onSubmit={apply}
        className="field-grid"
        aria-label="Filter all indexed history"
      >
        <div>
          <label htmlFor={`${id}-status`}>Indexed history status</label>
          <select
            id={`${id}-status`}
            value={filter.status}
            onChange={(event) =>
              change({
                ...filter,
                status: event.target.value as IndexedHistoryFilter["status"],
                page: 1,
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed in the index</option>
            <option value="removed">Removed by reorganization</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-order`}>Indexed history order</label>
          <select
            id={`${id}-order`}
            value={filter.order}
            onChange={(event) =>
              change({
                ...filter,
                order: event.target.value as IndexedHistoryFilter["order"],
                page: 1,
              })
            }
          >
            <option value="newest">Newest block first</option>
            <option value="oldest">Oldest block first</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-event`}>Exact indexed event name</label>
          <input
            id={`${id}-event`}
            data-no-translate
            value={eventInput}
            onChange={(event) => setEventInput(event.target.value)}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor={`${id}-contract`}>Indexed contract address</label>
          <input
            id={`${id}-contract`}
            data-no-translate
            value={contractInput}
            onChange={(event) => setContractInput(event.target.value)}
            maxLength={42}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit">Apply indexed history filters</button>
        <button
          type="button"
          onClick={() => {
            setEventInput("");
            setContractInput("");
            change({ ...initialIndexedHistoryFilter });
          }}
        >
          Reset all indexed history filters
        </button>
      </form>
      <p>
        Active event filter:{" "}
        <span data-no-translate>{filter.eventName || "—"}</span>. Active
        contract filter:{" "}
        <span data-no-translate>{filter.contractAddress || "—"}</span>.
      </p>
      {inputError ? <p role="alert">{inputError}</p> : null}
      <div aria-live="polite">
        {state.status === "loading" ? (
          <p role="status">Reading indexed transaction history...</p>
        ) : null}
        {state.status === "error" ? (
          <p role="alert">
            Indexed transaction history is unavailable. Retry or sign in again
            if your session ended.
          </p>
        ) : null}
        {page ? <IndexedHistoryEntries page={page} /> : null}
      </div>
      {page ? (
        <nav aria-label="All indexed transaction history pages">
          <button
            type="button"
            disabled={filter.page <= 1}
            onClick={() => change({ ...filter, page: filter.page - 1 })}
          >
            Previous indexed history page
          </button>
          <span> Indexed history page {filter.page} </span>
          <button
            type="button"
            disabled={
              filter.page >= indexedHistoryPageLimit ||
              filter.page * page.pageSize >= page.total
            }
            onClick={() => change({ ...filter, page: filter.page + 1 })}
          >
            Next indexed history page
          </button>
        </nav>
      ) : null}
      {page &&
      filter.page === indexedHistoryPageLimit &&
      filter.page * page.pageSize < page.total ? (
        <p role="status">
          The history query page limit was reached. This does not establish
          complete history.
        </p>
      ) : null}
    </article>
  );
}

export function IndexedHistoryEntries({ page }: { page: IndexedHistoryPage }) {
  return (
    <div>
      <p>
        The current indexed snapshot reports {page.total} matching participant
        event(s). Returned {page.data.length} on this page.
      </p>
      {page.data.length === 0 ? (
        <p>
          No indexed event was returned on this page for these filters. If
          records changed, refresh or return to an earlier page.
        </p>
      ) : (
        <ol start={(page.filters.page - 1) * page.pageSize + 1}>
          {page.data.map((entry) => (
            <li key={entry.id} data-testid="portfolio-indexed-history-entry">
              <strong data-no-translate>{entry.eventName}</strong>
              <p>
                {entry.status === "removed"
                  ? "Removed from the canonical chain; the earlier indexed confirmation no longer applies."
                  : entry.status === "confirmed"
                    ? "Confirmed in the indexed observation."
                    : "Confirmation is pending in the index."}
              </p>
              <dl className="wallet-facts">
                <div>
                  <dt>Transaction</dt>
                  <dd data-no-translate>{entry.transactionHash}</dd>
                </div>
                <div>
                  <dt>Contract</dt>
                  <dd data-no-translate>{entry.contractAddress}</dd>
                </div>
                <div>
                  <dt>Block / log</dt>
                  <dd data-no-translate>
                    {entry.blockNumber} / {entry.logIndex}
                  </dd>
                </div>
                <div>
                  <dt>Last indexed update, UTC</dt>
                  <dd data-no-translate>
                    <time dateTime={entry.observedAt}>{entry.observedAt}</time>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
