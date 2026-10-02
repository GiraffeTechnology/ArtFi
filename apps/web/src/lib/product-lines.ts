/** Product entry points: explicit client clarification of 2026-10-02.
 * Keep the three product models separate while retaining the existing workflows.
 */
export const productLines = [
  {
    number: "01",
    title: "NFT",
    href: "/nft",
    detail:
      "Digital collectibles without real-world asset backing, connected with CCHS and traded primarily on OpenSea. Charity editions remain an independent capability.",
    label: "Digital collectibles · CCHS · OpenSea",
    action: "Explore NFTs",
  },
  {
    number: "02",
    title: "Whole-artwork RWA",
    href: "/rwa",
    detail:
      "The token is a pickup voucher or warehouse receipt for one whole artwork. ERC-8415 supports asset identity, registry synchronization and the asset lifecycle.",
    label: "Whole artwork · Receipt token · ERC-8415",
    action: "Explore whole-artwork RWA",
  },
  {
    number: "03",
    title: "Fractional trading & DAO",
    href: "/market/fractionals",
    detail:
      "The original ArtFi workflow: create a Vault, fractionalize an eligible asset, inspect positions and trade, then use the corresponding DAO governance controls.",
    label: "Vault · Fractions · Asset-specific governance",
    action: "Explore fractions & DAO",
  },
] as const;

export const productNavigation = [
  ["Overview", "/"],
  ["NFT", "/nft"],
  ["Whole RWA", "/rwa"],
  ["Fractions & DAO", "/market/fractionals"],
] as const;

export const toolNavigation = [
  ["Market mirror", "/market/rwa"],
  ["Activity", "/market/activity"],
  ["Charity", "/charity"],
  ["Mint", "/create/rwa"],
  ["Wallet", "/portfolio"],
  ["DAO", "/dao"],
  ["Projects", "/projects"],
  ["Operations", "/operations"],
] as const;
