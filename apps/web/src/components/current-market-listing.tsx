"use client";

import { useEffect, useState } from "react";

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
type AssetIdentity = {
  chain: string;
  contractAddress: string;
  tokenId: string;
};
type Listing = {
  source: string;
  schemaVersion: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  status: string;
  observedAtMs: number;
  price?: string;
  currency?: string;
  decimals?: number;
  validUntilMs?: number;
  orderHash?: string;
};
type Snapshot = {
  data: Listing | null;
  freshness: string;
  receivedAtMs: number;
};

function matches(asset: AssetIdentity, value: AssetIdentity) {
  return (
    value.chain === asset.chain &&
    value.contractAddress === asset.contractAddress.toLowerCase() &&
    value.tokenId === asset.tokenId
  );
}

function formattedPrice(value: string, decimals: number) {
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

export function CurrentMarketListing({ asset }: { asset: AssetIdentity }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [nowMs, setNowMs] = useState(0);
  const { chain, contractAddress, tokenId } = asset;
  useEffect(() => {
    const lifetime = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = new URLSearchParams({
          source: "opensea",
          chain,
          contract: contractAddress,
          tokenId,
        });
        const response = await fetch(`${apiURL}/v1/market/listing?${query}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) throw new Error("LISTING_READ_UNAVAILABLE");
        const body = await response.json();
        const receivedAtMs = Date.now();
        const identity = { chain, contractAddress, tokenId };
        if (
          !body ||
          body.schemaVersion !== "1" ||
          body.source !== "opensea" ||
          body.runtime !== true ||
          body.custody !== false ||
          body.execution !== "disabled" ||
          body.maxAgeSeconds !== 90 ||
          !matches(identity, body) ||
          !["fresh", "stale", "unknown"].includes(body.freshness) ||
          !Number.isFinite(Date.parse(body.asOf)) ||
          Math.abs(receivedAtMs - Date.parse(body.asOf)) > 15_000
        ) {
          throw new Error("LISTING_READ_IDENTITY_INVALID");
        }
        const data = body.data;
        if (data !== null) {
          if (
            !data ||
            !matches(identity, data) ||
            data.source !== "opensea" ||
            data.schemaVersion !== "1" ||
            ![
              "active",
              "inactive",
              "fulfilled",
              "expired",
              "cancelled",
              "not-found",
              "unavailable",
            ].includes(data.status) ||
            !Number.isSafeInteger(data.observedAtMs) ||
            data.observedAtMs <= 0
          )
            throw new Error("LISTING_READ_INVALID");
          if (
            !["not-found", "unavailable"].includes(data.status) &&
            (typeof data.price !== "string" ||
              !/^(0|[1-9][0-9]{0,77})$/.test(data.price) ||
              BigInt(data.price) >= 2n ** 256n ||
              typeof data.currency !== "string" ||
              !/^[A-Za-z0-9._-]{1,32}$/.test(data.currency) ||
              !Number.isInteger(data.decimals) ||
              data.decimals < 0 ||
              data.decimals > 36 ||
              !/^0x[0-9a-f]{64}$/.test(data.orderHash) ||
              !Number.isSafeInteger(data.validUntilMs) ||
              data.validUntilMs <= 0)
          ) {
            throw new Error("LISTING_PRICE_INVALID");
          }
        } else if (body.freshness !== "unknown")
          throw new Error("LISTING_MISSING_DATA");
        if (!lifetime.signal.aborted)
          setSnapshot({ data, freshness: body.freshness, receivedAtMs });
      } catch {
        if (!lifetime.signal.aborted) setSnapshot(undefined);
      } finally {
        busy = false;
      }
    };
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 15_000);
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      lifetime.abort();
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.clearInterval(clock);
    };
  }, [chain, contractAddress, tokenId]);
  const data = snapshot?.data;
  const age = data ? nowMs - data.observedAtMs : Number.POSITIVE_INFINITY;
  const fresh =
    nowMs > 0 &&
    data &&
    matches(asset, data) &&
    snapshot?.freshness === "fresh" &&
    nowMs - snapshot.receivedAtMs <= 30_000 &&
    age >= -5000 &&
    age <= 90_000;
  const status =
    fresh && data
      ? data.status === "active" && data.validUntilMs! <= nowMs
        ? "expired"
        : data.status
      : "unknown";
  const labels: Record<string, string> = {
    active: "OpenSea reports active",
    inactive: "OpenSea reports inactive",
    fulfilled: "OpenSea reports fulfilled",
    expired: "Listing expired",
    cancelled: "OpenSea reports cancelled",
    "not-found": "No listing returned by OpenSea",
    unavailable: "Provider probe unavailable",
    unknown: data
      ? "Current status stale or unconfirmed"
      : "Current status unavailable",
  };
  return (
    <div aria-label="Current marketplace listing" aria-live="polite">
      <strong>{labels[status]}</strong>
      {status === "active" &&
      data?.price !== undefined &&
      data.decimals !== undefined ? (
        <p data-no-translate>
          {formattedPrice(data.price, data.decimals)} {data.currency}
        </p>
      ) : null}
      {data && matches(asset, data) ? (
        <p>
          Checked{" "}
          <span data-no-translate>
            {new Date(data.observedAtMs).toLocaleString()}
          </span>
        </p>
      ) : null}
      <p>
        Read-only provider observation; not a guarantee of execution or a legal
        ownership claim.
      </p>
    </div>
  );
}
