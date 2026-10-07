export const rwaRegistryAbi = [
  {
    type: "function",
    name: "createAsset",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "metadataHash", type: "bytes32" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "nft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "AssetCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "requestId", type: "bytes32" },
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "creator", type: "address" },
      { indexed: false, name: "metadataHash", type: "bytes32" },
      { indexed: false, name: "metadataURI", type: "string" },
    ],
  },
] as const;

export const charityEditionsAbi = [
  {
    type: "function",
    name: "SERIES_CREATOR_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "EDITIONS_PER_ARTWORK",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "PRIMARY_PRICE_WEI",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "seriesCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // The public view of one edition. `masterArtworkHash` is a commitment, never a locator: it
    // names no object and resolves to nothing a browser can fetch (CH.6, CH.7).
    type: "function",
    name: "series",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "artworkId", type: "bytes32" },
          { name: "masterArtworkHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "distributionWallet", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "soldOutAt", type: "uint64" },
          { name: "physicalDonationRecordedAt", type: "uint64" },
          { name: "selloutEvidenceHash", type: "bytes32" },
          { name: "physicalDonationEvidenceHash", type: "bytes32" },
          { name: "metadataURI", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "createSeries",
    stateMutability: "nonpayable",
    inputs: [
      { name: "artworkId", type: "bytes32" },
      { name: "masterArtworkHash", type: "bytes32" },
      { name: "metadataHash", type: "bytes32" },
      { name: "distributionWallet", type: "address" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "event",
    name: "SeriesCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "artworkId", type: "bytes32" },
      { indexed: true, name: "masterArtworkHash", type: "bytes32" },
      { indexed: false, name: "distributionWallet", type: "address" },
      { indexed: false, name: "metadataHash", type: "bytes32" },
      { indexed: false, name: "metadataURI", type: "string" },
    ],
  },
] as const;

export const vaultFactoryAbi = [
  {
    type: "function",
    name: "CREATOR_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "createVault",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "vaultName", type: "string" },
      { name: "collection", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "admin", type: "address" },
      { name: "pauser", type: "address" },
      { name: "fractionalizer", type: "address" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "event",
    name: "VaultCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "requestId", type: "bytes32" },
      { indexed: true, name: "vault", type: "address" },
      { indexed: true, name: "collection", type: "address" },
      { indexed: false, name: "tokenId", type: "uint256" },
      { indexed: false, name: "vaultName", type: "string" },
    ],
  },
] as const;

export const erc721VaultApprovalAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "operator", type: "address" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const artFiVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "fractionalize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "supply", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "event",
    name: "NFTDeposited",
    anonymous: false,
    inputs: [
      { indexed: true, name: "collection", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
      { indexed: true, name: "owner", type: "address" },
    ],
  },
  {
    type: "event",
    name: "Fractionalized",
    anonymous: false,
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "supply", type: "uint256" },
    ],
  },
] as const;

export const artFiAdminSafeAbi = [
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "allowed", type: "bool" }],
  },
  {
    type: "function",
    name: "threshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "delaySeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "transactionId", type: "uint256" }],
  },
  {
    type: "function",
    name: "confirm",
    stateMutability: "nonpayable",
    inputs: [{ name: "transactionId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [{ name: "transactionId", type: "uint256" }],
    outputs: [{ name: "returndata", type: "bytes" }],
  },
  {
    type: "function",
    name: "transaction",
    stateMutability: "view",
    inputs: [{ name: "transactionId", type: "uint256" }],
    outputs: [
      {
        name: "entry",
        type: "tuple",
        components: [
          { name: "requestId", type: "bytes32" },
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "readyAt", type: "uint64" },
          { name: "confirmations", type: "uint32" },
          { name: "executed", type: "bool" },
        ],
      },
    ],
  },
] as const;

/**
 * `WholeArtworkMarket` — signature settlement for a whole artwork.
 *
 * The `SaleIntent` tuple's field order is part of the EIP-712 type hash. It must match
 * `SALE_INTENT_TYPEHASH` in the contract and `saleIntentTypes` in `whole-artwork-intent.ts`;
 * both suites assert the same fixed digest so a reorder fails a test rather than a fill.
 */
export const wholeArtworkMarketAbi = [
  {
    type: "function",
    name: "fillIntent",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "seller", type: "address" },
          { name: "collection", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "paymentToken", type: "address" },
          { name: "price", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "salt", type: "uint256" },
          { name: "startsAt", type: "uint48" },
          { name: "endsAt", type: "uint48" },
          { name: "epoch", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sellerEpoch",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "intentUsed",
    stateMutability: "view",
    inputs: [{ name: "intentHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "incrementEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "allowedCollection",
    stateMutability: "view",
    inputs: [{ name: "collection", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowedPaymentToken",
    stateMutability: "view",
    inputs: [{ name: "paymentToken", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * `ArtFiMarket` — signature settlement for fractions.
 *
 * The fixed-price path the client ruling of 2026-08-30 moved off escrow (`PRD.md` §4.2.2). The
 * `SaleIntent` tuple's field order is part of the EIP-712 type hash: it must match
 * `SALE_INTENT_TYPEHASH` in `ArtFiMarket.sol` and `fractionIntentTypes` in `fraction-intent.ts`,
 * and all three are pinned by the same fixed digest in the Solidity and browser suites.
 *
 * Only the signature-settlement surface is declared here. Auctions keep escrow under the same
 * ruling and have their own path in the contract; nothing on this screen reaches them.
 */
export const artFiFractionMarketAbi = [
  {
    type: "function",
    name: "fillIntent",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "seller", type: "address" },
          { name: "assetToken", type: "address" },
          { name: "paymentToken", type: "address" },
          { name: "maxAmount", type: "uint256" },
          { name: "unitPrice", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "salt", type: "uint256" },
          { name: "startsAt", type: "uint48" },
          { name: "endsAt", type: "uint48" },
          { name: "epoch", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeIntent",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "seller", type: "address" },
          { name: "assetToken", type: "address" },
          { name: "paymentToken", type: "address" },
          { name: "maxAmount", type: "uint256" },
          { name: "unitPrice", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "salt", type: "uint256" },
          { name: "startsAt", type: "uint48" },
          { name: "endsAt", type: "uint48" },
          { name: "epoch", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "incrementSellerEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "sellerEpoch",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "intentFilled",
    stateMutability: "view",
    inputs: [{ name: "intentHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowedAssetToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowedPaymentToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    // The pilot spend limit a buyer is subject to. Read so the surface can say a fill would be
    // refused before asking for a transaction that reverts with `PilotCapExceeded`.
    type: "function",
    name: "pilotPaymentCap",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "paymentToken", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pilotPaymentUsed",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "paymentToken", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * The ERC-20 reads and the one write the fraction settlement surface needs.
 *
 * Both legs of a fill are ERC-20 transfers, so the same shape serves the fraction token and the
 * payment token.
 */
export const fractionTokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The reads the listing surface needs from the artwork's ERC-721 contract. */
export const wholeArtworkCollectionAbi = [
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "operator", type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;
