/**
 * Venue links and record freshness for the external-market mirror — #110 §2 XM.4 and XM.5.
 *
 * XM.4 requires each mirrored record to carry its external market, order ID, time, freshness and an
 * HTTPS deep link out to the venue. Two rules shape how that link reaches a page:
 *
 *   - **A link is attributed, never constructed.** The mirror shows the URL the source reported. It
 *     never assembles one from a chain and a token ID, because a URL ArtFi invented is a claim
 *     about the venue that no observed event supports (XM.5).
 *   - **It is re-validated here anyway.** The API rejects a non-HTTPS or off-host URL on ingest, but
 *     a record can predate a check and a page is the last place a bad `href` becomes clickable. An
 *     unverifiable URL yields no link at all rather than a link the page hopes is safe.
 *
 * `freshness` exists because a timestamp is not freshness. "Observed 14:03" tells a reader nothing
 * about whether the mirror is current; "4 minutes ago" does.
 */

/** Mirrors the API's own ingest rule: an OpenSea event must link to opensea.io and nowhere else. */
const venueHosts: Record<string, readonly string[]> = {
  opensea: ["opensea.io"],
};

export function venueLabel(source: string): string {
  return source === "opensea" ? "OpenSea" : source;
}

/**
 * The reported URL, or `undefined` when it cannot be shown safely.
 *
 * Refused: a URL that does not parse, any scheme but HTTPS, embedded credentials, and any host
 * outside the source's allowlist. A subdomain is not accepted for the same reason a lookalike
 * domain is not: the check is equality against the allowed host.
 */
export function venueLink(
  source: string,
  reportedUrl: string | undefined,
): string | undefined {
  const allowed = venueHosts[source];
  if (!allowed || !reportedUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(reportedUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (!allowed.includes(parsed.hostname.toLowerCase())) return undefined;
  return parsed.toString();
}

/** A short, non-misleading order identifier. The full hash stays in the record. */
export function shortOrderId(
  orderHash: string | undefined,
): string | undefined {
  if (!orderHash || !/^0x[0-9a-fA-F]{64}$/.test(orderHash)) return undefined;
  return `${orderHash.slice(0, 10)}…${orderHash.slice(-6)}`;
}

/**
 * How old the observation is, in the coarsest unit that is still honest.
 *
 * A timestamp in the future is reported as such rather than rounded to "just now": a source clock
 * ahead of this one is a data problem a reader should see, not one the page should hide.
 */
export function freshness(
  observedAt: string | undefined,
  now: Date = new Date(),
): string {
  if (!observedAt) return "Freshness unknown";
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return "Freshness unknown";

  const seconds = Math.round((now.getTime() - observed) / 1000);
  if (seconds < -60) return "Source clock ahead";
  if (seconds < 60) return "Under a minute ago";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
