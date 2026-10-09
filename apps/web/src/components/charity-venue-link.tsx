"use client";

import { publicSetting } from "@/lib/public-runtime-config";

import { useCallback, useEffect, useState } from "react";

import {
  charityVenueState,
  findCharityVenueRecord,
  type CharityVenueRecord,
  type CharityVenueState,
} from "@/lib/charity-venue";
import { freshness } from "@/lib/market-links";

/** Observed edition activity and source evidence. External navigation belongs in the footer. */

const apiURL = (publicSetting("NEXT_PUBLIC_API_URL") || "").replace(/\/$/, "");

type MarketCatalogResponse = {
  data: CharityVenueRecord[];
  total: number;
  runtime: true;
};

function collectionAddress(): string | undefined {
  const configured = publicSetting(
    "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  )?.trim();
  return configured && /^0x[0-9a-fA-F]{40}$/.test(configured)
    ? configured
    : undefined;
}

export function CharityVenueLink({ tokenId }: Readonly<{ tokenId: string }>) {
  const contract = collectionAddress();
  const [state, setState] = useState<CharityVenueState>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!contract) return;
    try {
      /**
       * Paged through to the end, not read off the first page.
       *
       * `/v1/market/assets` is paginated and its page size caps at 100. Reading page one alone meant
       * that once a collection carried more than 100 mirrored token ids, an edition on any later page
       * reported as having no observed activity and silently lost its venue link — a durable record
       * existing all the while. "Not found yet" is not "not observed", and only exhausting the
       * pages tells the two apart.
       */
      const found = await findCharityVenueRecord(
        async (page, pageSize) => {
          const response = await fetch(
            `${apiURL}/v1/market/assets?source=opensea&contract=${contract}&page=${page}&pageSize=${pageSize}`,
            { cache: "no-store" },
          );
          if (!response.ok) {
            throw new Error(
              `The external-market mirror answered HTTP ${response.status}.`,
            );
          }
          const body = (await response.json()) as MarketCatalogResponse;
          if (body.runtime !== true || !Array.isArray(body.data)) {
            throw new Error("The market catalog response is not runtime data.");
          }
          return { data: body.data, total: body.total };
        },
        contract,
        tokenId,
      );
      setState(charityVenueState(found));
      setError(undefined);
    } catch (caught) {
      // Fail closed: no state at all rather than a stale or invented one.
      setState(undefined);
      setError(
        caught instanceof Error
          ? caught.message
          : "The external-market mirror is unavailable.",
      );
    }
  }, [contract, tokenId]);

  // Deferred to a task rather than run in the effect body, so the fetch's state lands in its own
  // render instead of cascading out of this one — the same shape the live market catalog uses.
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  if (!contract) {
    return (
      <div className="disabled-action" role="note" data-testid="charity-venue">
        <strong>No venue record can be looked up</strong>
        <span>
          The charity collection address is not configured, so this page has
          nothing to match an observed marketplace record against. It shows no
          link rather than one it assembled itself.
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="disabled-action" role="note" data-testid="charity-venue">
        <strong>The venue record is unavailable</strong>
        <span>
          {error} No link is shown, because the only link this page may show is
          one the mirror observed.
        </span>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="disabled-action" role="note" data-testid="charity-venue">
        <strong>Reading the venue record</strong>
        <span>
          Looking for an observed marketplace record for this edition.
        </span>
      </div>
    );
  }

  if (state.kind === "unobserved") {
    return (
      <div className="disabled-action" role="note" data-testid="charity-venue">
        <strong>No marketplace activity has been observed</strong>
        <span>
          Nothing has been mirrored for this edition yet, so there is no venue
          link to show. ArtFi does not construct one.
        </span>
      </div>
    );
  }

  if (state.kind === "unattributed") {
    return (
      <div className="disabled-action" role="note" data-testid="charity-venue">
        <strong>No venue link was attributed</strong>
        <span>
          {state.venue} activity was observed for this edition —{" "}
          {state.eventType}, {freshness(state.observedAt)} — but it reported no
          link that can be shown safely.
        </span>
      </div>
    );
  }

  return (
    <div className="transaction-panel" data-testid="charity-venue">
      <p className="eyebrow">Where this edition trades</p>
      <p>
        Activity for this edition was observed on {state.venue}. This does not
        establish a current executable listing. Native NFT trading is available
        for configured supported collections in the NFT marketplace.
      </p>
      <dl className="contract-facts">
        <div>
          <dt>Venue</dt>
          <dd>{state.venue}</dd>
        </div>
        <div>
          <dt>Latest observed event</dt>
          <dd>{state.eventType}</dd>
        </div>
        {state.orderStatus && (
          <div>
            <dt>Order status</dt>
            <dd>{state.orderStatus}</dd>
          </div>
        )}
        <div>
          <dt>Observed</dt>
          <dd>{freshness(state.observedAt)}</dd>
        </div>
      </dl>
      <details className="market-source-reference">
        <summary>Source reference</summary>
        <p data-no-translate>{state.url}</p>
      </details>
    </div>
  );
}
