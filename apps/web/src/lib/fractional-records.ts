import type {
  FractionalCatalogPage,
  FractionalCatalogRecord,
} from "@giraffetechnology/artfi-api-client";

export function fractionalAddress(value: unknown): value is `0x${string}` {
  return (
    typeof value === "string" &&
    /^0x[0-9a-f]{40}$/.test(value) &&
    value !== "0x0000000000000000000000000000000000000000"
  );
}

function uint(value: unknown, bits: bigint, nonzero = false): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) < 2n ** bits &&
    (!nonzero || value !== "0")
  );
}

export function fractionalIssuance(item: FractionalCatalogRecord): boolean {
  return (
    Boolean(item) &&
    uint(item.eventId, 64n, true) &&
    fractionalAddress(item.vaultAddress) &&
    fractionalAddress(item.collectionAddress) &&
    uint(item.tokenId, 256n) &&
    fractionalAddress(item.fractionTokenAddress) &&
    uint(item.supply, 256n, true) &&
    fractionalAddress(item.issuanceRecipient) &&
    typeof item.vaultName === "string" &&
    new TextEncoder().encode(item.vaultName).length >= 2 &&
    new TextEncoder().encode(item.vaultName).length <= 80 &&
    /^0x[0-9a-f]{64}$/.test(item.transactionHash) &&
    /^0x[0-9a-f]{64}$/.test(item.blockHash) &&
    uint(item.blockNumber, 64n) &&
    Number.isInteger(item.logIndex) &&
    item.logIndex >= 0 &&
    item.logIndex <= 4294967295 &&
    typeof item.observedAt === "string" &&
    Number.isFinite(Date.parse(item.observedAt))
  );
}

/** Index discovery is never proof of a wallet balance or current NFT custody. */
export function fractionalPage(
  value: unknown,
  limit: number,
): value is FractionalCatalogPage {
  if (!value || typeof value !== "object") return false;
  const page = value as FractionalCatalogPage;
  if (
    page.runtime !== true ||
    page.readOnly !== true ||
    page.chainId !== 560048 ||
    page.evidence !== "indexed-confirmed-events" ||
    !fractionalAddress(page.factoryAddress) ||
    !Array.isArray(page.data) ||
    page.data.length > limit ||
    !page.data.every(fractionalIssuance) ||
    typeof page.nextCursor !== "string" ||
    page.nextCursor.length > 512 ||
    (page.nextCursor !== "" &&
      (!/^[A-Za-z0-9_-]+$/.test(page.nextCursor) || page.data.length === 0))
  )
    return false;
  const vaults = new Set<string>();
  const tokens = new Set<string>();
  let previous: bigint | undefined;
  for (const item of page.data) {
    const id = BigInt(item.eventId);
    if (
      vaults.has(item.vaultAddress) ||
      tokens.has(item.fractionTokenAddress) ||
      (previous !== undefined && id >= previous)
    )
      return false;
    vaults.add(item.vaultAddress);
    tokens.add(item.fractionTokenAddress);
    previous = id;
  }
  return true;
}
