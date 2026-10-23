"use client";

import { useCallback, useState } from "react";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

const activityFamilies = new Set(["order", "sale", "transfer", "metadata"]);
const activityStatuses = new Set([
  "active",
  "cancelled",
  "invalidated",
  "fulfilled",
  "observed",
]);

type MarketActivity = {
  eventId: string;
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  eventType: string;
  eventFamily: string;
  status: "active" | "cancelled" | "invalidated" | "fulfilled" | "observed";
  price?: string;
  paymentSymbol?: string;
  eventTimestamp: string;
};

type MarketActivityResponse = {
  data: MarketActivity[];
  schemaVersion: "1";
  source: string;
  execution: "external-deeplink-only";
  custody: false;
  hasMore: boolean;
  nextCursor?: string;
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
  const [opened, setOpened] = useState(false);
  const [items, setItems] = useState<MarketActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();

  const loadPage = useCallback(
    async (cursor?: string) => {
      setLoading(true);
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
          typeof body.hasMore !== "boolean" ||
          (body.hasMore &&
            (typeof body.nextCursor !== "string" ||
              body.nextCursor.length === 0 ||
              body.nextCursor.length > 512)) ||
          !Array.isArray(body.data) ||
          body.data.some(
            (item) =>
              !/^[0-9a-f]{64}$/.test(item.eventId) ||
              item.source !== source ||
              item.chain !== chain ||
              item.contractAddress.toLowerCase() !==
                contractAddress.toLowerCase() ||
              item.tokenId !== tokenId ||
              !activityFamilies.has(item.eventFamily) ||
              !activityStatuses.has(item.status) ||
              Number.isNaN(Date.parse(item.eventTimestamp)),
          )
        ) {
          throw new Error(
            "The activity response crossed its read-only boundary.",
          );
        }
        setItems((current) => {
          const previous = cursor ? current : [];
          const known = new Set(previous.map((item) => item.eventId));
          return [
            ...previous,
            ...body.data.filter((item) => !known.has(item.eventId)),
          ];
        });
        setHasMore(body.hasMore);
        setNextCursor(body.nextCursor);
        setHistoryError(undefined);
      } catch (error) {
        setHistoryError(
          error instanceof Error
            ? error.message
            : "Market activity is unavailable.",
        );
      } finally {
        setLoading(false);
      }
    },
    [chain, contractAddress, source, tokenId],
  );

  if (!opened) {
    return (
      <button
        className="market-history-toggle"
        type="button"
        onClick={() => {
          setOpened(true);
          void loadPage();
        }}
      >
        View transaction history
      </button>
    );
  }

  return (
    <section
      className="market-history"
      aria-label={`Transaction history for token ${tokenId}`}
    >
      <header>
        <strong>Public-market activity</strong>
        <span>Read-only · {source}</span>
      </header>

      {historyError ? (
        <div className="market-history__error" role="alert">
          <span>{historyError}</span>
          <button type="button" onClick={() => void loadPage()}>
            Retry history
          </button>
        </div>
      ) : null}

      {!loading && !historyError && items.length === 0 ? (
        <p>No attributed activity has been observed for this token.</p>
      ) : null}

      {items.length > 0 ? (
        <ol>
          {items.map((item) => (
            <li key={item.eventId}>
              <div>
                <strong>{formatActivityLabel(item)}</strong>
                <span>
                  {item.eventFamily} · {item.status}
                </span>
              </div>
              <div>
                <span>{formatActivityPrice(item)}</span>
                <time dateTime={item.eventTimestamp}>
                  {formatObserved(item.eventTimestamp)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {loading ? <p role="status">Loading attributed activity…</p> : null}
      {hasMore && nextCursor && !historyError ? (
        <button
          className="market-history-toggle"
          type="button"
          disabled={loading}
          onClick={() => void loadPage(nextCursor)}
        >
          Load more activity
        </button>
      ) : null}
    </section>
  );
}

function formatActivityLabel(item: MarketActivity) {
  return item.eventType.replaceAll("_", " ");
}

function formatActivityPrice(item: MarketActivity) {
  if (!item.price) return "No price reported";
  return `${item.price} ${item.paymentSymbol || "units"}`;
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
