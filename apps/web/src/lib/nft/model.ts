import { isAddress, parseEther, type Address, type Hex } from "viem";

export const NFT_CHAINS = { ethereum: 1, base: 8453 } as const;
export type NftChain = keyof typeof NFT_CHAINS;
export type NftAction = "list" | "offer" | "buy" | "accept" | "cancel";
export type NftScope = {
  slug: string;
  chain: NftChain;
  contract: Address;
  standard: "erc721" | "erc1155";
  label: string;
  charity: boolean;
};
export type NftRequest = {
  action: NftAction;
  collection: string;
  tokenId: string;
  account: Address;
  quantity: string;
  priceWei: string;
  expiresAt: number;
  orderHash?: Hex;
};
export type NftTransaction = { to: Address; data: Hex; value: string };
export type NftTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "OrderComponents";
  message: Record<string, unknown>;
};
/** Public binding only. This record is never an authentication credential. */
export type NftTaskBinding = {
  taskId: string;
  taskDigest: string;
  executorDigest: string;
  grantReference: string;
  grantPolicyVersion: string;
  operationId: string;
};
export type NftTaskPrincipal = NftTaskBinding & { kind: "task" };
export type NftPlan = {
  id: string;
  operationId: string;
  sessionId?: string;
  taskPrincipal?: NftTaskPrincipal;
  chainId: number;
  request: NftRequest;
  scope: NftScope;
  expiresAt: number;
  kind: "approval" | "signature" | "transaction";
  summary: string;
  orderHash?: Hex;
  orderExpiresAt?: number;
  orderTotalWei?: string;
  paymentToken?: "ETH" | "WETH";
  transaction?: NftTransaction;
  typedData?: NftTypedData;
  fees: { recipient: string; amountWei: string }[];
  sourceURL?: string;
};
export type NftView = {
  tokenId: string;
  name: string;
  contract: string;
  standard: string;
  collection: string;
  sourceURL?: string;
};
export type NftOrderView = {
  hash: Hex;
  side: "listing" | "offer";
  maker: string;
  quantity: string;
  priceWei: string;
  currency: string;
  expiresAt: number;
  status: string;
  sourceURL?: string;
};
export class NftError extends Error {
  constructor(
    public status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NftError";
  }
}
export function fail(message: string, status = 422): never {
  throw new NftError(status, message);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid NFT data.");
  return value as Record<string, unknown>;
}
export function uint(value: unknown, nonzero = false): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n ||
    (nonzero && value === "0")
  )
    fail("Invalid token quantity or amount.");
  return value;
}
export function equalAddress(a: unknown, b: unknown) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    isAddress(a) &&
    isAddress(b) &&
    a.toLowerCase() === b.toLowerCase()
  );
}
export function readNftRequest(value: unknown, now = Date.now()): NftRequest {
  const item = object(value);
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "action",
          "collection",
          "tokenId",
          "account",
          "quantity",
          "priceWei",
          "expiresAt",
          "orderHash",
        ].includes(key),
    )
  )
    fail("Unknown NFT request field.", 400);
  if (
    !["list", "offer", "buy", "accept", "cancel"].includes(
      String(item.action),
    ) ||
    typeof item.collection !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(item.collection) ||
    typeof item.account !== "string" ||
    !isAddress(item.account)
  )
    fail("Invalid NFT request.", 400);
  const tokenId = uint(item.tokenId),
    quantity = uint(item.quantity, true),
    priceWei = uint(item.priceWei);
  if (BigInt(quantity) > 1000000n)
    fail("Quantity exceeds the supported order size.");
  const creating = item.action === "list" || item.action === "offer";
  if (
    creating &&
    (!Number.isSafeInteger(item.expiresAt) ||
      Number(item.expiresAt) <= Math.floor(now / 1000) + 120 ||
      Number(item.expiresAt) > Math.floor(now / 1000) + 180 * 86400 ||
      priceWei === "0")
  )
    fail(
      "Use a positive price and an expiry between two minutes and 180 days.",
    );
  if (
    !creating &&
    (!Number.isSafeInteger(item.expiresAt) || Number(item.expiresAt) < 0)
  )
    fail("Invalid order expiry.", 400);
  if (
    !creating &&
    (typeof item.orderHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(item.orderHash))
  )
    fail("A canonical OpenSea order is required.");
  return {
    action: item.action as NftAction,
    collection: item.collection,
    tokenId,
    account: item.account.toLowerCase() as Address,
    quantity,
    priceWei,
    expiresAt: Number(item.expiresAt || 0),
    ...(item.orderHash
      ? { orderHash: String(item.orderHash).toLowerCase() as Hex }
      : {}),
  };
}
export function nftRights(charity: boolean) {
  return charity
    ? "This digital edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction rights. The holder benefit is a distinct high-resolution watermarked file after ownership verification. ArtFi issues no donation receipt or tax-credit promise."
    : "Digital collectible only. No physical-asset backing, warehouse receipt, redemption or fractional investment rights.";
}

/** User amounts are exact wei; never silently round additional decimal places. */
export function nftPriceWei(value: string): string {
  if (value.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value))
    throw new NftError(
      400,
      "Enter an exact positive ETH or WETH amount with at most 18 decimal places.",
    );
  const amount = parseEther(value);
  if (amount <= 0n || amount >= 1n << 256n)
    throw new NftError(
      400,
      "The NFT order amount is outside the supported range.",
    );
  return amount.toString();
}

export type NftOperationSummary = {
  id: string;
  chainId: number;
  status: string;
  action: string;
  collection: string;
  tokenId: string;
  kind: string;
  walletStarted: boolean;
  transactionHash?: string;
  orderHash?: string;
  updatedAt: string;
};
export type NftOperationHistory = {
  data: NftOperationSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  wallet: string;
  chainId: number;
};
