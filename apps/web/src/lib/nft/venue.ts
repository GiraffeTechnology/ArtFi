import "server-only";
import { OpenSeaAPI, type FetchImpl } from "@opensea/sdk";
import { nftAPIKey } from "./config";
import {
  NftError,
  equalAddress,
  object,
  uint,
  type NftScope,
  type NftView,
} from "./model";
import { sdkChain } from "./validation";

export class NftVenueRejection extends NftError {
  constructor(public upstreamStatus: number) {
    super(422, "OpenSea rejected the order submission.");
  }
}
export function attributedNftURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ["opensea.io", "www.opensea.io"].includes(url.hostname) &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {}
  return undefined;
}
export function venueFetch(mode: "read" | "prepare" | "submit"): FetchImpl {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method || "GET").toUpperCase();
    if (
      url.origin !== "https://api.opensea.io" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new NftError(503, "Unexpected venue destination.");
    if (
      method !== "GET" &&
      !(
        method === "POST" &&
        ((mode === "prepare" &&
          /^\/api\/v2\/(listings|offers)\/fulfillment_data$/.test(
            url.pathname,
          )) ||
          (mode === "submit" &&
            /^\/api\/v2\/orders\/(ethereum|base)\/seaport\/(listings|offers)$/.test(
              url.pathname,
            )))
      )
    )
      throw new NftError(403, "This venue action is not allowed.");
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (
        mode === "submit" &&
        [400, 401, 403, 404, 422].includes(response.status)
      )
        throw new NftVenueRejection(response.status);
      throw new NftError(
        response.status === 404 ? 404 : response.status === 429 ? 429 : 503,
        response.status === 404
          ? "No current venue record was found."
          : response.status === 429
            ? "OpenSea is rate-limiting requests. Try again later."
            : "OpenSea is temporarily unavailable.",
      );
    }
    const length = response.headers.get("content-length");
    if (length && Number(length) > 1048576) {
      await response.body?.cancel();
      throw new NftError(503, "The venue response is too large.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new NftError(503, "The venue response is empty.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 1048576) {
          await reader.cancel();
          throw new NftError(503, "The venue response is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}
export function nftAPI(
  scope: NftScope,
  mode: "read" | "prepare" | "submit" = "read",
) {
  return new OpenSeaAPI({
    chain: sdkChain(scope),
    apiKey: nftAPIKey(),
    fetch: venueFetch(mode),
  });
}
export async function checkNftChain(api: OpenSeaAPI, scope: NftScope) {
  const data = await api.chains.getChains();
  if (!data.chains.some((chain) => chain.chain === scope.chain))
    throw new NftError(
      503,
      "OpenSea does not currently support this collection's chain.",
    );
}
export function safeNft(value: unknown, scope: NftScope): NftView {
  const nft = object(value);
  if (
    !equalAddress(nft.contract, scope.contract) ||
    nft.collection !== scope.slug ||
    nft.tokenStandard !== scope.standard
  )
    throw new NftError(
      503,
      "The venue NFT does not match the configured digital collection.",
    );
  return {
    tokenId: uint(nft.identifier),
    name:
      typeof nft.name === "string"
        ? nft.name.slice(0, 200)
        : `Token ${nft.identifier}`,
    contract: scope.contract,
    standard: scope.standard,
    collection: scope.slug,
    ...(attributedNftURL(nft.openseaUrl)
      ? { sourceURL: attributedNftURL(nft.openseaUrl) }
      : {}),
  };
}
