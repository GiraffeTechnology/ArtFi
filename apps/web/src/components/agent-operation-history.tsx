"use client";
import { useEffect, useRef, useState } from "react";
import {
  agentHistoryScopeKey,
  fetchAgentHistoryPage,
  type AgentHistoryPage,
  type AgentHistoryScope,
} from "@/lib/agent-operation-history";

export function AgentOperationHistory({
  initial,
  scope,
}: {
  initial: AgentHistoryPage;
  scope: AgentHistoryScope;
}) {
  const scopeKey = agentHistoryScopeKey(scope);
  return (
    <PrivateHistory
      key={scopeKey + ":" + initial.after + ":" + initial.nextAfter}
      initial={initial}
      scope={scope}
    />
  );
}
function PrivateHistory({
  initial,
  scope,
}: {
  initial: AgentHistoryPage;
  scope: AgentHistoryScope;
}) {
  const [page, setPage] = useState<AgentHistoryPage | undefined>(initial);
  const [cursors, setCursors] = useState(["0"]);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true),
    flight = useRef(false),
    generation = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const scopeKey = agentHistoryScopeKey(scope);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      activeRequest.current?.abort();
    };
  }, []);
  async function load(after: string, nextIndex: number, nextCursors: string[]) {
    if (flight.current) return;
    const current = ++generation.current,
      controller = new AbortController();
    activeRequest.current = controller;
    flight.current = true;
    setIndex(nextIndex);
    setCursors(nextCursors);
    setBusy(true);
    setError("");
    setPage(undefined);
    setFilter("");
    try {
      const result = await fetchAgentHistoryPage(scope, after, {
        signal: controller.signal,
      });
      if (
        live.current &&
        generation.current === current &&
        result.scopeKey === scopeKey
      ) {
        setPage(result);
        setIndex(nextIndex);
        setCursors(nextCursors);
      }
    } catch {
      if (live.current && generation.current === current)
        setError(
          "History could not be read. Previous records are hidden; retry this page or refresh from the beginning.",
        );
    } finally {
      flight.current = false;
      if (live.current && generation.current === current) setBusy(false);
    }
  }
  const currentPage = page?.scopeKey === scopeKey ? page : undefined;
  const events =
    currentPage?.events.filter((row) => !filter || row.state === filter) ?? [];
  return (
    <section
      aria-label="Durable operation history"
      data-no-translate="true"
      data-translation-skip="true"
    >
      <h2>Durable operation history</h2>
      <p>
        Saved events describe the operation log, not new execution authority or
        proof of settlement.
      </p>
      <div className="dao-actions-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => void load("0", 0, ["0"])}
        >
          Refresh history from beginning
        </button>
        <button
          type="button"
          disabled={busy || index === 0}
          onClick={() => void load(cursors[index - 1], index - 1, cursors)}
        >
          Previous history page
        </button>
        <button
          type="button"
          disabled={busy || !currentPage?.mayHaveMore || index >= 999}
          onClick={() => {
            if (!currentPage) return;
            const next = [
              ...cursors.slice(0, index + 1),
              currentPage.nextAfter,
            ];
            void load(currentPage.nextAfter, index + 1, next);
          }}
        >
          Next history page
        </button>
        {!currentPage && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(cursors[index], index, cursors)}
          >
            Retry history page
          </button>
        )}
      </div>
      {busy && <p role="status">Reading this history page…</p>}
      {error && <p role="alert">{error}</p>}
      {currentPage && (
        <>
          <p>
            Page {index + 1} · {currentPage.events.length} returned events ·
            after cursor {currentPage.after}.
          </p>
          {!currentPage.pagingAvailable && (
            <p>
              Workflow history service did not provide a pagination cursor. Only
              this returned batch is shown; complete history is not established.
            </p>
          )}
          {currentPage.pagingAvailable && !currentPage.mayHaveMore && (
            <p>
              No further events were indicated by this read. Refresh to check
              for new events; this is not a permanent end of history.
            </p>
          )}
          {index >= 999 && currentPage.mayHaveMore && (
            <p>
              This view reached its 1000-page navigation limit. Further events
              are not marked complete.
            </p>
          )}
          <label>
            State filter on this page
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All returned states</option>
              {[...new Set(currentPage.events.map((row) => row.state))]
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
            </select>
          </label>
          {events.length ? (
            <ol>
              {events.map((row) => (
                <li key={row.id}>
                  Event {row.id} · {row.state}
                  {row.kind ? " · " + row.kind : ""}
                  {row.reason ? " · " + row.reason : ""}
                  {" · "}
                  {new Date(row.observedAt).toISOString()}
                  {row.version === null ? "" : " · version " + row.version}
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {currentPage.events.length
                ? "No events match the state filter on this page."
                : "No events were returned for this read."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
