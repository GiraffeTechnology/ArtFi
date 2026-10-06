import { venueLabel, venueLink } from "./market-links";

/** Retain only source-attributed, validated venue URLs as evidence; never invent a listing. */

export type CharityVenueRecord = {
  source: string;
  chain: string;
  contractAddress: string;
  tokenId: string;
  latestEventType: string;
  latestEventTimestamp: string;
  orderStatus?: string;
  marketplaceUrl?: string;
};

export type CharityVenueState =
  /** An observed record whose reported URL survived re-validation. */
  | {
      kind: "attributed";
      url: string;
      venue: string;
      eventType: string;
      orderStatus?: string;
      observedAt: string;
    }
  /** An observed record with no URL, or one that could not be shown safely. */
  | {
      kind: "unattributed";
      venue: string;
      eventType: string;
      observedAt: string;
    }
  /** Nothing has been observed for this edition. */
  | { kind: "unobserved" };

/**
 * The record for one edition, chosen by contract and token id.
 *
 * Both must match. A token id alone is not an identity — every collection numbers from one — and a
 * record from another contract carrying the same id describes a different asset entirely.
 *
 * Ties are broken by the most recent observation, because the mirror's catalog is deduplicated per
 * asset but a caller may hand this function an unfiltered list.
 */
export function selectCharityVenueRecord(
  records: readonly CharityVenueRecord[],
  contractAddress: string,
  tokenId: string,
): CharityVenueRecord | undefined {
  const wanted = contractAddress.toLowerCase();
  return records
    .filter(
      (record) =>
        record.contractAddress.toLowerCase() === wanted &&
        record.tokenId === tokenId,
    )
    .sort(
      (left, right) =>
        Date.parse(right.latestEventTimestamp) -
        Date.parse(left.latestEventTimestamp),
    )
    .at(0);
}

/** One page of `/v1/market/assets`, as the mirror returns it. */
export type CharityVenuePage = {
  data: CharityVenueRecord[];
  total: number;
};

/**
 * The edition's record, looked for across every page the mirror has.
 *
 * `/v1/market/assets` is paginated and its page size caps at 100. Reading only the first page meant
 * that once a collection carried more than 100 mirrored token ids, an edition on a later page came
 * back as "no marketplace activity observed" while a durable record existed all along — the page
 * then said there was no venue link when there was one. **"Not found yet" is not "not observed",**
 * and only exhausting the pages tells the two apart.
 *
 * Three ways the walk ends, so a mirror that disagrees with itself cannot spin it: the record is
 * found, a page comes back empty, or everything `total` promised has been seen. `pageLimit` is a
 * last backstop for a `total` that never arrives.
 */
export async function findCharityVenueRecord(
  fetchPage: (page: number, pageSize: number) => Promise<CharityVenuePage>,
  contractAddress: string,
  tokenId: string,
  options: { pageSize?: number; pageLimit?: number } = {},
): Promise<CharityVenueRecord | undefined> {
  const pageSize = options.pageSize ?? 100;
  const pageLimit = options.pageLimit ?? 100;

  let collected = 0;
  for (let page = 1; page <= pageLimit; page += 1) {
    const body = await fetchPage(page, pageSize);
    const found = selectCharityVenueRecord(body.data, contractAddress, tokenId);
    if (found) return found;
    if (body.data.length === 0) return undefined;
    collected += body.data.length;
    if (collected >= body.total) return undefined;
  }
  return undefined;
}

/** What the page may say, given the record the mirror has for this edition. */
export function charityVenueState(
  record: CharityVenueRecord | undefined,
): CharityVenueState {
  if (!record) return { kind: "unobserved" };
  const venue = venueLabel(record.source);
  const url = venueLink(record.source, record.marketplaceUrl);
  if (!url) {
    return {
      kind: "unattributed",
      venue,
      eventType: record.latestEventType,
      observedAt: record.latestEventTimestamp,
    };
  }
  return {
    kind: "attributed",
    url,
    venue,
    eventType: record.latestEventType,
    ...(record.orderStatus ? { orderStatus: record.orderStatus } : {}),
    observedAt: record.latestEventTimestamp,
  };
}
