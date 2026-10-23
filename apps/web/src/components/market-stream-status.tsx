"use client";

import { useEffect, useState } from "react";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type StreamObservation = {
  source: string;
  collectionSlug: string;
  transportState: "connecting" | "connected" | "disconnected" | "stopped";
  freshness: "fresh" | "stale";
  observedAt: string;
  receivedAt: string;
};

export function MarketStreamStatus({
  source = "opensea",
}: {
  source?: string;
}) {
  const [snapshot, setSnapshot] = useState<{
    source: string;
    data: StreamObservation[];
    expiresAt: number;
  }>();
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const lifetime = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = new URLSearchParams({ source });
        const response = await fetch(`${apiURL}/v1/market/streams?${query}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) throw new Error("MARKET_STREAM_UNAVAILABLE");
        const body = await response.json();
        const receivedAt = Date.now();
        if (
          !body ||
          body.schemaVersion !== "1" ||
          body.source !== source ||
          body.runtime !== true ||
          body.scope !== "transport-only" ||
          body.maxAgeSeconds !== 90 ||
          typeof body.asOf !== "string" ||
          !Number.isFinite(Date.parse(body.asOf)) ||
          Math.abs(receivedAt - Date.parse(body.asOf)) > 15_000 ||
          !Array.isArray(body.data) ||
          body.data.length > 1000
        ) {
          throw new Error("MARKET_STREAM_INVALID");
        }
        const seen = new Set<string>();
        for (const item of body.data) {
          if (
            !item ||
            item.source !== source ||
            typeof item.collectionSlug !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(item.collectionSlug) ||
            seen.has(item.collectionSlug) ||
            !["connecting", "connected", "disconnected", "stopped"].includes(
              item.transportState,
            ) ||
            !["fresh", "stale"].includes(item.freshness) ||
            typeof item.observedAt !== "string" ||
            !Number.isFinite(Date.parse(item.observedAt)) ||
            typeof item.receivedAt !== "string" ||
            !Number.isFinite(Date.parse(item.receivedAt))
          ) {
            throw new Error("MARKET_STREAM_INVALID");
          }
          seen.add(item.collectionSlug);
        }
        if (!lifetime.signal.aborted) {
          setSnapshot({
            source,
            data: body.data,
            expiresAt: receivedAt + 30_000,
          });
          setNowMs(receivedAt);
        }
      } catch {
        if (!lifetime.signal.aborted) setSnapshot(undefined);
      } finally {
        busy = false;
      }
    };
    const start = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 15_000);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      lifetime.abort();
      window.clearTimeout(start);
      window.clearInterval(interval);
      window.clearInterval(clock);
      window.removeEventListener("focus", focus);
    };
  }, [source]);

  const data = snapshot?.source === source ? snapshot.data : [];
  const snapshotFresh =
    snapshot?.source === source && nowMs > 0 && nowMs <= snapshot.expiresAt;
  return (
    <aside
      className="market-runtime-state"
      aria-label="Source stream transport"
    >
      <strong>Stream connection observations</strong>
      <p>
        Transport only. An open connection does not prove collection
        subscription delivery, complete history, or current listing
        availability.
      </p>
      {data.length === 0 ? (
        <p role="status">
          Stream state unknown. No fixture or history sweep is used as
          connection evidence.
        </p>
      ) : (
        <details>
          <summary>
            {snapshotFresh
              ? "Latest transport observations"
              : "Transport observations expired"}{" "}
            · {data.length} collection scopes
          </summary>
          <ul>
            {data.map((item) => {
              const fresh =
                snapshotFresh &&
                item.freshness === "fresh" &&
                [item.observedAt, item.receivedAt].every((value) => {
                  const age = nowMs - Date.parse(value);
                  return age >= -5000 && age <= 90_000;
                });
              const label = !fresh
                ? "Stale — current connection unknown"
                : item.transportState === "connected"
                  ? "Transport open — subscriptions not attested"
                  : item.transportState === "connecting"
                    ? "Connecting"
                    : item.transportState === "stopped"
                      ? "Stopped"
                      : "Disconnected";
              return (
                <li key={item.collectionSlug}>
                  <span data-no-translate>{item.collectionSlug}</span>: {label}
                  {" · "}
                  <time data-no-translate dateTime={item.observedAt}>
                    {item.observedAt}
                  </time>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </aside>
  );
}
