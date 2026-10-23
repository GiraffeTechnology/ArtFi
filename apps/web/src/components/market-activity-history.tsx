"use client";

import { useCallback, useState } from "react";

import { venueLabel, venueLink } from "@/lib/market-links";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type MarketActivity = {
  eventId: string;
  source: string;
  eventType: string;
  eventFamily: string;
  chain: string;
  transactionHash?: string;
  price?: string;
  paymentSymbol?: string;
  marketplaceUrl?: string;
  eventTimestamp: string;
  receivedAt: string;
};

type MarketActivityResponse = {
  data: MarketActivity[];
  nextCursor?: string;
  hasMore: boolean;
  schemaVersion: "1";
  source: string;
  execution: "external-deeplink-only";
  custody: false;
};

type MarketActivityHistoryProps = {
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
};

export function MarketActivityHistory({
  source,
  chain,
  contractAddress,
  tokenId,
}: Readonly<MarketActivityHistoryProps>) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<MarketActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const loadPage = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const query = new URLSearchParams({
          source,
          chain,
          contract: contractAddress,
          tokenId,
          limit: "20",
        });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(
          `${apiURL}/v1/market/activity?${query.toString()}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw await responseError(response);
        const body = (await response.json()) as MarketActivityResponse;
        if (
          body.schemaVersion !== "1" ||
          body.source !== source ||
          body.execution !== "external-deeplink-only" ||
          body.custody !== false ||
          !Array.isArray(body.data)
        ) {
          throw new Error(
            "The market history response crossed its read-only boundary.",
          );
        }
        setItems((current) => {
          const merged = cursor ? [...current, ...body.data] : body.data;
          return Array.from(
            new Map(merged.map((item) => [item.eventId, item])).values(),
          );
        });
        setNextCursor(body.nextCursor);
        setHasMore(body.hasMore);
        setLoaded(true);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Market activity history is unavailable.",
        );
      } finally {
        setLoading(false);
      }
    },
    [chain, contractAddress, source, tokenId],
  );

  function toggleHistory() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !loaded && !loading) void loadPage();
  }

  return (
    <section className="market-activity" aria-label="Mirrored market activity">
      <button type="button" onClick={toggleHistory}>
        {expanded ? "Hide activity history" : "View activity history"}
      </button>
      {expanded ? (
        <div className="market-activity__panel">
          <p className="market-gate">
            Read-only attributed venue history. ArtFi does not sign, submit,
            match, custody or settle these events.
          </p>
          {error ? (
            <div role="alert">
              <strong>Activity history unavailable</strong>
              <span>{error} No fixture is shown as live history.</span>
            </div>
          ) : null}
          {loading && !loaded ? <p>Loading activity history…</p> : null}
          {loaded && !error && items.length === 0 ? (
            <p>
              No attributed market activity has been observed for this token.
            </p>
          ) : null}
          {items.length > 0 ? (
            <ol>
              {items.map((item) => {
                const link = venueLink(item.source, item.marketplaceUrl);
                return (
                  <li key={item.eventId}>
                    <strong>{activityLabel(item)}</strong>
                    <span>
                      {formatObserved(item.eventTimestamp)} · received{" "}
                      {formatObserved(item.receivedAt)}
                    </span>
                    {link ? (
                      <a
                        className="text-link market-venue-link"
                        href={link}
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                      >
                        Open attributed event on {venueLabel(item.source)}
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {hasMore && nextCursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPage(nextCursor)}
            >
              {loading ? "Loading…" : "Load more activity"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function activityLabel(item: MarketActivity) {
  const label = item.eventType.replaceAll("_", " ");
  if (item.price) {
    return `${label} · ${item.price} ${item.paymentSymbol || "units"}`;
  }
  return label || item.eventFamily;
}

function formatObserved(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown time"
    : parsed.toLocaleString();
}

async function responseError(response: Response) {
  const fallback = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as { detail?: string };
    return new Error(body.detail || fallback);
  } catch {
    return new Error(fallback);
  }
}
