// Public read-only data only. Never forward protocol signatures or raw payloads.
export type MarketTokenIdentity = {
  chain: string;
  contractAddress: string;
  tokenId: string;
  collectionSlug?: string;
};

export type CurrentListingObservation = MarketTokenIdentity & {
  schemaVersion: "1";
  source: "opensea";
  observedAtMs: number;
  status:
    | "active"
    | "inactive"
    | "fulfilled"
    | "expired"
    | "cancelled"
    | "not-found"
    | "unavailable";
  orderHash?: string;
  price?: string;
  currency?: string;
  decimals?: number;
  validUntilMs?: number;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uint256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) < 2n ** 256n
  );
}

export function normalizeCurrentListing(
  input: unknown,
  asset: MarketTokenIdentity,
  observedAtMs: number,
): CurrentListingObservation {
  const listing = object(input);
  const identity = object(listing.asset);
  const parameters = object(object(listing.protocol_data).parameters);
  const offer = Array.isArray(parameters.offer)
    ? parameters.offer.map(object)
    : [];
  const price = object(object(listing.price).current);
  const hash = listing.order_hash;
  // Collection + tokenId alone is ambiguous for multi-contract collections.
  // Seaport's offered token is mandatory. The API's optional asset summary,
  // when present, must not contradict it.
  if (
    listing.chain !== asset.chain ||
    (listing.asset !== undefined &&
      listing.asset !== null &&
      (typeof identity.contract !== "string" ||
        identity.contract.toLowerCase() !== asset.contractAddress ||
        (identity.identifier !== undefined &&
          identity.identifier !== asset.tokenId))) ||
    !uint256(asset.tokenId) ||
    offer.length !== 1 ||
    ![2, 3].includes(Number(offer[0].itemType)) ||
    typeof offer[0].token !== "string" ||
    offer[0].token.toLowerCase() !== asset.contractAddress ||
    offer[0].identifierOrCriteria !== asset.tokenId ||
    typeof hash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(hash) ||
    !uint256(parameters.startTime) ||
    !uint256(parameters.endTime) ||
    !uint256(price.value) ||
    typeof price.currency !== "string" ||
    !/^[A-Za-z0-9._-]{1,32}$/.test(price.currency) ||
    typeof price.decimals !== "number" ||
    !Number.isInteger(price.decimals) ||
    price.decimals < 0 ||
    price.decimals > 36 ||
    typeof listing.remaining_quantity !== "number" ||
    !Number.isSafeInteger(listing.remaining_quantity) ||
    listing.remaining_quantity < 0
  ) {
    throw new Error("OPENSEA_LISTING_IDENTITY_OR_PRICE_INVALID");
  }
  const status =
    typeof listing.status === "string" ? listing.status.toLowerCase() : "";
  if (
    !["active", "inactive", "fulfilled", "expired", "cancelled"].includes(
      status,
    )
  ) {
    throw new Error("OPENSEA_LISTING_STATUS_INVALID");
  }
  const end = BigInt(parameters.endTime) * 1000n;
  const start = BigInt(parameters.startTime) * 1000n;
  if (end > BigInt(Number.MAX_SAFE_INTEGER) || end <= start) {
    throw new Error("OPENSEA_LISTING_WINDOW_INVALID");
  }
  let effectiveStatus = status as CurrentListingObservation["status"];
  if (effectiveStatus === "active") {
    if (end <= BigInt(observedAtMs)) effectiveStatus = "expired";
    else if (start > BigInt(observedAtMs) || listing.remaining_quantity === 0)
      effectiveStatus = "inactive";
  }
  return {
    ...asset,
    schemaVersion: "1",
    source: "opensea",
    observedAtMs,
    status: effectiveStatus,
    orderHash: hash.toLowerCase(),
    price: price.value,
    currency: price.currency,
    decimals: price.decimals,
    validUntilMs: Number(end),
  };
}

export async function readCurrentListing(
  asset: MarketTokenIdentity,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CurrentListingObservation> {
  // Capture request-start time so an older in-flight result cannot beat a newer probe.
  const observedAtMs = Date.now();
  const base: CurrentListingObservation = {
    ...asset,
    schemaVersion: "1",
    source: "opensea",
    observedAtMs,
    status: "unavailable",
  };
  if (
    !asset.collectionSlug ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(asset.collectionSlug)
  )
    return base;
  try {
    const response = await fetchImpl(
      `https://api.opensea.io/api/v2/listings/collection/${encodeURIComponent(asset.collectionSlug)}/nfts/${encodeURIComponent(asset.tokenId)}/best?include_private_listings=false`,
      {
        headers: { "x-api-key": apiKey },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      // A provider 404 is not proof that the token is unlisted everywhere.
      return { ...base, status: "not-found" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return base;
    }
    // Only the normalized safe fields below are retained; never log raw responses.
    const reader = response.body?.getReader();
    if (!reader) return base;
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1_048_576)
          throw new Error("OPENSEA_LISTING_RESPONSE_TOO_LARGE");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return normalizeCurrentListing(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      asset,
      observedAtMs,
    );
  } catch {
    signal.throwIfAborted();
    return base;
  }
}
