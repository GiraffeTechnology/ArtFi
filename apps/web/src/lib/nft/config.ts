import "server-only";
import { isAddress } from "viem";
import { NFT_CHAINS, NftError, object, type NftScope } from "./model";

export const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const WETH = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
};
export function nftScopes(): NftScope[] {
  try {
    const raw: unknown = JSON.parse(
      process.env.ARTFI_NFT_COLLECTIONS_JSON || "[]",
    );
    if (!Array.isArray(raw) || raw.length > 100) throw new Error();
    const seen = new Set<string>();
    return raw.map((value) => {
      const item = object(value);
      if (
        Object.keys(item).some(
          (key) =>
            ![
              "slug",
              "chain",
              "contract",
              "standard",
              "label",
              "charity",
            ].includes(key),
        ) ||
        typeof item.slug !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,99}$/.test(item.slug) ||
        seen.has(item.slug) ||
        !Object.hasOwn(NFT_CHAINS, String(item.chain)) ||
        typeof item.contract !== "string" ||
        !isAddress(item.contract) ||
        item.contract.toLowerCase() === ZERO ||
        !["erc721", "erc1155"].includes(String(item.standard)) ||
        typeof item.label !== "string" ||
        !item.label.trim() ||
        item.label.length > 160 ||
        typeof item.charity !== "boolean"
      )
        throw new Error();
      seen.add(item.slug);
      return item as NftScope;
    });
  } catch {
    throw new NftError(503, "The NFT collection configuration is unavailable.");
  }
}
export function nftScope(slug: string) {
  const scope = nftScopes().find((item) => item.slug === slug);
  if (!scope)
    throw new NftError(404, "This digital NFT collection is not configured.");
  return scope;
}
export function nftAPIKey() {
  const key = process.env.OPENSEA_API_KEY?.trim();
  if (!key) throw new NftError(503, "OpenSea access is not configured.");
  return key;
}
export function nftRPC(chainId: number) {
  if (process.env.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE !== "sin")
    throw new NftError(
      503,
      "NFT chain verification is not configured in the execution zone.",
    );
  const value = process.env[`ARTFI_NFT_RPC_${chainId}`]?.trim();
  try {
    const url = new URL(value || "");
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new NftError(503, "The NFT chain connection is unavailable.");
  }
}
export function requireNftTrading() {
  if (process.env.ARTFI_NFT_TRADING_ENABLED !== "true")
    throw new NftError(
      503,
      "Native NFT trading is not enabled for this installation.",
    );
}
