import { isAddress, type Address, type Hex } from "viem";
import { fractionIntentHash, type FractionSaleIntent } from "./fraction-intent";
import { saleIntentHash, type SaleIntent } from "./whole-artwork-intent";

export type NativeOrderKind = "whole" | "fraction";
export type NativeOrder = {
  kind: NativeOrderKind;
  chainId: 560048;
  marketAddress: Address;
  intentHash: Hex;
  intent: Record<string, string | number>;
  signature: Hex;
  createdAt?: string;
};
export type DecodedNativeOrder =
  | { order: NativeOrder; kind: "whole"; intent: SaleIntent }
  | { order: NativeOrder; kind: "fraction"; intent: FractionSaleIntent };

const maxUint256 = (1n << 256n) - 1n;
const maxUint48 = 2 ** 48 - 1;
const commonFields = [
  "seller",
  "paymentToken",
  "buyer",
  "salt",
  "startsAt",
  "endsAt",
  "epoch",
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Order terms must be a JSON object.");
  return value as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error("An order address is malformed.");
  return value.toLowerCase() as Address;
}
function uint(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) > maxUint256
  )
    throw new Error("Order amounts must be canonical decimal uint256 strings.");
  return BigInt(value);
}
function timestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maxUint48
  )
    throw new Error("Order times must be uint48 seconds.");
  return value;
}
export function orderSignature(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    value.length > 16386 ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  )
    throw new Error("An order signature is malformed or too large.");
  return value as Hex;
}

/** One bounded wire format for browser publication, durable storage, and buyer restoration. */
export function decodeNativeOrder(value: unknown): DecodedNativeOrder {
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "kind",
          "chainId",
          "marketAddress",
          "intentHash",
          "intent",
          "signature",
          "createdAt",
        ].includes(key),
    )
  )
    throw new Error("The order contains unsupported fields.");
  if (input.kind !== "whole" && input.kind !== "fraction")
    throw new Error("The order kind is unsupported.");
  if (input.chainId !== 560048)
    throw new Error(
      "This order does not target the supported Hoodi test chain.",
    );
  const marketAddress = address(input.marketAddress);
  const signature = orderSignature(input.signature);
  const source = object(input.intent);
  const fields = [
    ...commonFields,
    ...(input.kind === "whole"
      ? ["collection", "tokenId", "price"]
      : ["assetToken", "maxAmount", "unitPrice"]),
  ];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((key) => !fields.includes(key))
  )
    throw new Error("The order's signed fields do not match its kind.");
  const common = {
    seller: address(source.seller),
    paymentToken: address(source.paymentToken),
    buyer: address(source.buyer),
    salt: uint(source.salt),
    startsAt: timestamp(source.startsAt),
    endsAt: timestamp(source.endsAt),
    epoch: uint(source.epoch),
  };
  const domain = { chainId: input.chainId, verifyingContract: marketAddress };
  const decoded =
    input.kind === "whole"
      ? {
          kind: "whole" as const,
          intent: {
            ...common,
            collection: address(source.collection),
            tokenId: uint(source.tokenId),
            price: uint(source.price),
          },
        }
      : {
          kind: "fraction" as const,
          intent: {
            ...common,
            assetToken: address(source.assetToken),
            maxAmount: uint(source.maxAmount),
            unitPrice: uint(source.unitPrice),
          },
        };
  const intentHash =
    decoded.kind === "whole"
      ? saleIntentHash(decoded.intent, domain, 560048)
      : fractionIntentHash(decoded.intent, domain, 560048);
  if (
    typeof input.intentHash !== "string" ||
    input.intentHash.toLowerCase() !== intentHash
  )
    throw new Error(
      "The order hash does not match its signed terms and deployment.",
    );
  const intent = Object.fromEntries(
    Object.entries(decoded.intent).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
  const order: NativeOrder = {
    kind: decoded.kind,
    chainId: 560048,
    marketAddress,
    intentHash,
    intent,
    signature,
  };
  if (input.createdAt !== undefined) {
    if (
      typeof input.createdAt !== "string" ||
      !Number.isFinite(Date.parse(input.createdAt))
    )
      throw new Error("The order publication time is malformed.");
    order.createdAt = input.createdAt;
  }
  return { ...decoded, order };
}

/** Adapts the existing seller-export format without changing the contract's signed terms. */
export function nativeOrderFromAuthorization(
  kind: NativeOrderKind,
  raw: string,
  marketAddress: Address,
): NativeOrder {
  const body = object(JSON.parse(raw));
  const source = object(body.intent);
  // Hashing happens only after strict field validation in decodeNativeOrder. This first digest
  // derives from the existing component's own signed in-memory terms; imported input is still checked.
  const big = (name: string) => uint(source[name]);
  const common = {
    seller: address(source.seller),
    paymentToken: address(source.paymentToken),
    buyer: address(source.buyer),
    salt: big("salt"),
    startsAt: timestamp(source.startsAt),
    endsAt: timestamp(source.endsAt),
    epoch: big("epoch"),
  };
  const domain = { chainId: 560048, verifyingContract: marketAddress };
  const intentHash =
    kind === "whole"
      ? saleIntentHash(
          {
            ...common,
            collection: address(source.collection),
            tokenId: big("tokenId"),
            price: big("price"),
          },
          domain,
          560048,
        )
      : fractionIntentHash(
          {
            ...common,
            assetToken: address(source.assetToken),
            maxAmount: big("maxAmount"),
            unitPrice: big("unitPrice"),
          },
          domain,
          560048,
        );
  return decodeNativeOrder({
    kind,
    chainId: 560048,
    marketAddress,
    intentHash,
    intent: source,
    signature: body.signature,
  }).order;
}

export function nativeOrderAuthorization(order: NativeOrder) {
  return JSON.stringify(
    { intent: order.intent, signature: order.signature },
    null,
    2,
  );
}
