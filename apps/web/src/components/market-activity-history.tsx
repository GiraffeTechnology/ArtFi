"use client";

import { useEffect, useRef, useState } from "react";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Activity = {
  eventId: string;
  eventType: string;
  eventFamily: string;
  eventTimestamp: string;
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  transactionHash?: string;
  orderHash?: string;
  price?: string;
  paymentSymbol?: string;
};

type ActivityPage = {
  data: Activity[];
  nextCursor?: string;
  schemaVersion: "1";
  source: string;
  execution: "external-deeplink-only";
  custody: false;
  runtime: true;
};

type AssetIdentity = {
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
};

export function MarketActivityHistory({
  asset,
}: Readonly<{ asset: AssetIdentity }>) {
  return (
    <TokenMarketActivityHistory
      key={`${asset.source}:${asset.chain}:${asset.contractAddress.toLowerCase()}:${asset.tokenId}`}
      asset={asset}
    />
  );
}

function TokenMarketActivityHistory({
  asset,
}: Readonly<{ asset: AssetIdentity }>) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<Activity[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const seenCursors = useRef(new Set<string>());

  useEffect(() => () => pending.current?.abort(), []);

  async function load(cursor?: string) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        source: asset.source,
        chain: asset.chain,
        contract: asset.contractAddress,
        tokenId: asset.tokenId,
        limit: "25",
      });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiURL}/v1/market/activity?${query}`, {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok)
        throw new Error(`History unavailable (${response.status}).`);
      const page = (await response.json()) as ActivityPage;
      if (
        !page ||
        !Array.isArray(page.data) ||
        page.data.length > 25 ||
        page.schemaVersion !== "1" ||
        page.source !== asset.source ||
        page.execution !== "external-deeplink-only" ||
        page.custody !== false ||
        page.runtime !== true ||
        !page.data.every(
          (event) =>
            event &&
            event.source === asset.source &&
            event.chain === asset.chain &&
            event.contractAddress?.toLowerCase() ===
              asset.contractAddress.toLowerCase() &&
            event.tokenId === asset.tokenId &&
            typeof event.eventId === "string" &&
            /^[0-9a-f]{64}$/.test(event.eventId) &&
            ["order", "sale", "transfer", "metadata"].includes(
              event.eventFamily,
            ) &&
            typeof event.eventType === "string" &&
            event.eventType.length > 0 &&
            event.eventType.length <= 48 &&
            typeof event.eventTimestamp === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
              event.eventTimestamp,
            ) &&
            Number.isFinite(Date.parse(event.eventTimestamp)) &&
            (event.transactionHash === undefined ||
              (typeof event.transactionHash === "string" &&
                /^0x[0-9a-f]{64}$/i.test(event.transactionHash))) &&
            (event.orderHash === undefined ||
              (typeof event.orderHash === "string" &&
                /^0x[0-9a-f]{64}$/i.test(event.orderHash))) &&
            (event.price === undefined ||
              (typeof event.price === "string" &&
                /^(0|[1-9][0-9]{0,77})$/.test(event.price) &&
                BigInt(event.price) < 2n ** 256n)) &&
            (event.paymentSymbol === undefined ||
              (typeof event.paymentSymbol === "string" &&
                event.paymentSymbol.length <= 16)),
        ) ||
        new Set(page.data.map((event) => event.eventId)).size !==
          page.data.length ||
        (cursor !== undefined &&
          page.data.some((event) =>
            events.some((previous) => previous.eventId === event.eventId),
          )) ||
        (page.nextCursor !== undefined &&
          (typeof page.nextCursor !== "string" ||
            page.nextCursor.length === 0 ||
            page.nextCursor.length > 1024 ||
            page.data.length === 0 ||
            page.nextCursor === cursor ||
            (cursor !== undefined && seenCursors.current.has(page.nextCursor))))
      ) {
        throw new Error("The marketplace history response is not canonical.");
      }
      const sequence =
        cursor && events.length > 0
          ? [events[events.length - 1], ...page.data]
          : page.data;
      for (let index = 1; index < sequence.length; index += 1) {
        const previous = sequence[index - 1];
        const current = sequence[index];
        if (
          current.eventTimestamp > previous.eventTimestamp ||
          (current.eventTimestamp === previous.eventTimestamp &&
            current.eventId >= previous.eventId)
        ) {
          throw new Error("The marketplace history ordering is inconsistent.");
        }
      }
      if (controller.signal.aborted) return;
      if (!cursor) seenCursors.current.clear();
      if (page.nextCursor) seenCursors.current.add(page.nextCursor);
      setEvents((previous) =>
        cursor ? [...previous, ...page.data] : page.data,
      );
      setNextCursor(page.nextCursor);
      setLoaded(true);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "History unavailable.",
        );
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <section aria-label={`Market history for token ${asset.tokenId}`}>
      <button
        type="button"
        aria-expanded={opened}
        onClick={() => {
          setOpened((value) => !value);
          if (!loaded) void load();
        }}
      >
        {opened ? "Hide market history" : "View market history"}
      </button>
      {opened ? (
        <div>
          <p>
            Read-only external-market records; token holding is not proof of
            judicial rights.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          {loading ? <p>Loading market history…</p> : null}
          <button type="button" disabled={loading} onClick={() => void load()}>
            {loaded ? "Refresh history" : "Retry history"}
          </button>
          {loaded && events.length === 0 ? (
            <p>No mirrored events for this token.</p>
          ) : null}
          {events.length > 0 ? (
            <ol>
              {events.map((event) => (
                <li key={event.eventId}>
                  <span data-no-translate>
                    {event.eventFamily} · {event.eventType} ·{" "}
                    {event.eventTimestamp}
                  </span>
                  {event.price ? (
                    <>
                      {" "}
                      · raw amount{" "}
                      <span data-no-translate>
                        {event.price} {event.paymentSymbol || "units"}
                      </span>
                    </>
                  ) : null}
                  {event.transactionHash ? (
                    <div style={{ overflowWrap: "anywhere" }}>
                      Transaction:{" "}
                      <span data-no-translate>{event.transactionHash}</span>
                    </div>
                  ) : null}
                  {event.orderHash ? (
                    <div style={{ overflowWrap: "anywhere" }}>
                      Order: <span data-no-translate>{event.orderHash}</span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {loaded && !nextCursor && !error ? (
            <p>
              End of retained mirrored history. Provider completeness is not
              implied.
            </p>
          ) : null}
          {nextCursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(nextCursor)}
            >
              Load more history
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
