import { isAddress } from "viem";
import {
  administrationText,
  discardAdministrationBody,
  withAdministrationDeadline,
} from "./administration-transport";
import { readNativeOrderPage, type NativeOrderPage } from "./native-order-page";

export const portfolioPublicationPageSize = 10;
export const portfolioPublicationPageLimit = 1_000_000;
export const portfolioPublicationByteLimit = 512 * 1024;
export type PortfolioPublicationFilter = {
  kind: "all" | "whole" | "fraction";
  assetAddress: string;
  page: number;
};
export const initialPortfolioPublicationFilter: PortfolioPublicationFilter = {
  kind: "all",
  assetAddress: "",
  page: 1,
};

export class PortfolioPublicationsError extends Error {
  constructor() {
    super(
      "Published sale records are unavailable. Retry this read-only request.",
    );
    this.name = "PortfolioPublicationsError";
  }
}
function invalid(): never {
  throw new PortfolioPublicationsError();
}
function filterSnapshot(
  value: PortfolioPublicationFilter,
): PortfolioPublicationFilter {
  if (
    !value ||
    !["all", "whole", "fraction"].includes(value.kind) ||
    typeof value.assetAddress !== "string" ||
    (value.assetAddress !== "" && !isAddress(value.assetAddress)) ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    value.page > portfolioPublicationPageLimit
  )
    invalid();
  return {
    kind: value.kind,
    assetAddress: value.assetAddress.toLowerCase(),
    page: value.page,
  };
}
/** Private route filters never select a seller, chain, provider or credential. */
export function readPortfolioPublicationFilter(
  query: URLSearchParams,
): PortfolioPublicationFilter {
  for (const key of query.keys()) {
    if (
      !["kind", "assetAddress", "page"].includes(key) ||
      query.getAll(key).length !== 1 ||
      !query.get(key)
    )
      invalid();
  }
  const page = query.get("page") ?? "1";
  if (!/^[1-9][0-9]*$/.test(page)) invalid();
  return filterSnapshot({
    kind: (query.get("kind") ?? "all") as PortfolioPublicationFilter["kind"],
    assetAddress: query.get("assetAddress") ?? "",
    page: Number(page),
  });
}
export function portfolioPublicationQuery(
  address: string,
  rawFilter: PortfolioPublicationFilter,
) {
  if (!isAddress(address)) invalid();
  const filter = filterSnapshot(rawFilter);
  const query = new URLSearchParams({
    chainId: "560048",
    sellerAddress: address.toLowerCase(),
    page: String(filter.page),
    pageSize: String(portfolioPublicationPageSize),
  });
  if (filter.kind !== "all") query.set("kind", filter.kind);
  if (filter.assetAddress) query.set("assetAddress", filter.assetAddress);
  return query;
}
/** Reuse the exact native index contract and signed-term/deployment hash checks.
 * A publication is not proof of current fillability or on-chain settlement. */
export function readPortfolioPublicationPage(
  value: unknown,
  address: string,
  filter: PortfolioPublicationFilter,
): NativeOrderPage {
  const page = readNativeOrderPage(
    value,
    portfolioPublicationQuery(address, filter),
  );
  for (const order of page.data) {
    if (
      typeof order.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
        order.createdAt,
      ) ||
      !Number.isFinite(Date.parse(order.createdAt))
    )
      invalid();
  }
  return page;
}

export function portfolioPublicationNavigation(page: NativeOrderPage) {
  const first = (page.page - 1) * page.pageSize;
  const knownRows = first + page.data.length;
  return {
    previous: page.page > 1,
    // COUNT and SELECT are not one frozen snapshot. A full page permits probing
    // the next page even when the reported count is older than its records.
    next:
      page.page < portfolioPublicationPageLimit &&
      (page.page * page.pageSize < page.total ||
        page.data.length === page.pageSize),
    queryLimitReached:
      page.page === portfolioPublicationPageLimit &&
      (knownRows < page.total || page.data.length === page.pageSize),
    reportedCountChanged: page.data.length > 0 && knownRows > page.total,
  };
}

export async function requestPortfolioPublications(
  address: string,
  rawFilter: PortfolioPublicationFilter,
  parent: AbortSignal,
): Promise<NativeOrderPage> {
  const filter = filterSnapshot(rawFilter);
  if (!isAddress(address)) invalid();
  const query = new URLSearchParams({ page: String(filter.page) });
  if (filter.kind !== "all") query.set("kind", filter.kind);
  if (filter.assetAddress) query.set("assetAddress", filter.assetAddress);
  return withAdministrationDeadline(async (signal) => {
    const response = await fetch(
      `/api/portfolio/${address.toLowerCase()}/orders?${query}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      },
    );
    if (signal.aborted) {
      discardAdministrationBody(response);
      signal.throwIfAborted();
    }
    try {
      if (
        !response.ok ||
        response.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        invalid();
      const value: unknown = JSON.parse(
        await administrationText(
          response,
          portfolioPublicationByteLimit,
          signal,
        ),
      );
      return readPortfolioPublicationPage(value, address, filter);
    } finally {
      if (!response.bodyUsed) discardAdministrationBody(response);
    }
  }, parent);
}
