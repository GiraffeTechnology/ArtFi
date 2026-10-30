// Existing native NFT currency identities, shared by plan validation and the
// bounded reference compiler. No conversions or caller-defined token aliases.
export const ZERO = "0x0000000000000000000000000000000000000000";
export const WETH = Object.freeze({
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base: "0x4200000000000000000000000000000000000006",
});
export function nftPaymentAddress(chainId, currency) {
  const chain =
    chainId === "1" ? "ethereum" : chainId === "8453" ? "base" : null;
  if (chain === null) return null;
  return currency === "ETH" ? ZERO : currency === "WETH" ? WETH[chain] : null;
}
