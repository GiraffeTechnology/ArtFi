import { isAddress } from "viem";
export type RWAUnderlyingIdentity = {
  chainId: number;
  collectionAddress: string;
  tokenId: string;
};
export function underlyingIdentityQuery(
  input: URLSearchParams,
): RWAUnderlyingIdentity {
  if (
    [...input.keys()].some(
      (key) =>
        !["chainId", "collectionAddress", "tokenId"].includes(key) ||
        input.getAll(key).length !== 1,
    )
  )
    throw new Error(
      "Only the exact underlying chain, collection and token identity are allowed.",
    );
  const chainId = Number(input.get("chainId"));
  const collectionAddress = input.get("collectionAddress") || "";
  const tokenId = input.get("tokenId") || "";
  if (
    chainId !== 560048 ||
    input.get("chainId") !== "560048" ||
    !isAddress(collectionAddress, { strict: false }) ||
    /^0x0{40}$/i.test(collectionAddress) ||
    !/^(0|[1-9][0-9]{0,77})$/.test(tokenId) ||
    BigInt(tokenId) >= 1n << 256n
  )
    throw new Error("A supported, canonical underlying identity is required.");
  return { chainId, collectionAddress, tokenId };
}
export function assertUnderlyingStatus(
  value: unknown,
  expected: RWAUnderlyingIdentity,
) {
  const body = value as Partial<RWAUnderlyingIdentity> & {
    grounded?: unknown;
    checkedAt?: unknown;
  };
  if (
    !body ||
    body.grounded !== true ||
    body.chainId !== expected.chainId ||
    typeof body.collectionAddress !== "string" ||
    body.collectionAddress.toLowerCase() !==
      expected.collectionAddress.toLowerCase() ||
    body.tokenId !== expected.tokenId ||
    typeof body.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(body.checkedAt))
  )
    throw new Error(
      "No current approved-source status was returned for this exact underlying.",
    );
  return {
    chainId: body.chainId,
    collectionAddress: body.collectionAddress,
    tokenId: body.tokenId,
    grounded: true as const,
    checkedAt: body.checkedAt,
  };
}
/** Check immediately before new fraction issuance, never on an owner exit. */
export async function requireCurrentUnderlying(
  identity: RWAUnderlyingIdentity,
  assertCurrent: () => void,
  request: typeof fetch = fetch,
) {
  const query = new URLSearchParams({
    chainId: String(identity.chainId),
    collectionAddress: identity.collectionAddress,
    tokenId: identity.tokenId,
  });
  underlyingIdentityQuery(query);
  assertCurrent();
  const response = await request(`/api/rwa/underlying-status?${query}`, {
    cache: "no-store",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(12000),
  });
  assertCurrent();
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 409
        ? "The underlying RWA no longer has current approved-source evidence. Refresh its source claim before issuing new fractions."
        : "Current underlying source verification is unavailable. No new fraction issuance was requested.",
    );
  }
  const value: unknown = await response.json();
  assertCurrent();
  return assertUnderlyingStatus(value, identity);
}
