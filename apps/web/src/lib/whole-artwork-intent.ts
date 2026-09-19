import { hashTypedData, isAddress, type Address, type Hex } from "viem";

/**
 * EIP-712 sale intent for a whole artwork.
 *
 * This is the browser half of `packages/contracts/src/WholeArtworkMarket.sol`. The seller signs
 * the intent here; the artwork never leaves their wallet until the fill that intent authorized
 * (`PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6).
 *
 * The field order below fixes the EIP-712 type hash and must match `SALE_INTENT_TYPEHASH` in the
 * contract exactly. The two are not trusted to agree: `WholeArtworkMarket.t.sol` and
 * `whole-artwork-intent.test.ts` both assert against the same fixed digest, so a change on either
 * side fails a test rather than producing a signature the market silently rejects.
 */
export const saleIntentTypes = {
  SaleIntent: [
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
} as const;

export const saleIntentDomainName = "ArtFi Whole Artwork Market";
export const saleIntentDomainVersion = "1";

/** Open to any buyer. The contract reads the zero address as "unrestricted". */
export const anyBuyer = "0x0000000000000000000000000000000000000000" as const;

export type SaleIntent = {
  seller: Address;
  collection: Address;
  tokenId: bigint;
  paymentToken: Address;
  price: bigint;
  /** `anyBuyer` for an open intent, or the single address allowed to fill. */
  buyer: Address;
  salt: bigint;
  /**
   * Seconds. `uint48` in the contract, so a plain number is exact here -- its maximum is far
   * below `Number.MAX_SAFE_INTEGER` -- and it is what viem's typed-data encoder expects.
   */
  startsAt: number;
  /** Seconds, exclusive upper bound. `uint48`, as `startsAt`. */
  endsAt: number;
  epoch: bigint;
};

export type SaleIntentDomain = {
  chainId: number;
  /** The deployed `WholeArtworkMarket`. */
  verifyingContract: Address;
};

/** Every reason an intent is refused before a wallet is ever asked to sign. */
export type SaleIntentProblem =
  | "seller-missing"
  | "collection-missing"
  | "payment-token-missing"
  | "buyer-malformed"
  | "price-not-positive"
  | "window-not-positive"
  | "window-out-of-range"
  | "token-id-negative"
  | "salt-negative"
  | "epoch-negative"
  | "seller-is-buyer"
  | "market-missing"
  | "chain-mismatch";

const uint48Max = 281_474_976_710_655;

function addressProblem(
  value: string,
  missing: SaleIntentProblem,
): SaleIntentProblem | null {
  return isAddress(value) ? null : missing;
}

/**
 * Fail-closed validation of the terms the seller is about to authorize.
 *
 * Deliberately stricter than the contract in one place: an intent whose seller is also its named
 * buyer is refused here, so the wallet is never asked to sign terms `fillIntent` would revert on.
 */
export function validateSaleIntent(
  intent: SaleIntent,
  domain: SaleIntentDomain,
  expectedChainId: number,
): SaleIntentProblem[] {
  const problems: SaleIntentProblem[] = [];

  const seller = addressProblem(intent.seller, "seller-missing");
  if (seller) problems.push(seller);
  const collection = addressProblem(intent.collection, "collection-missing");
  if (collection) problems.push(collection);
  const paymentToken = addressProblem(
    intent.paymentToken,
    "payment-token-missing",
  );
  if (paymentToken) problems.push(paymentToken);
  if (!isAddress(intent.buyer)) problems.push("buyer-malformed");

  if (intent.price <= 0n) problems.push("price-not-positive");
  if (intent.tokenId < 0n) problems.push("token-id-negative");
  if (intent.salt < 0n) problems.push("salt-negative");
  if (intent.epoch < 0n) problems.push("epoch-negative");

  if (intent.startsAt >= intent.endsAt) problems.push("window-not-positive");
  if (
    !Number.isSafeInteger(intent.startsAt) ||
    !Number.isSafeInteger(intent.endsAt) ||
    intent.startsAt < 0 ||
    intent.endsAt < 0 ||
    intent.startsAt > uint48Max ||
    intent.endsAt > uint48Max
  ) {
    problems.push("window-out-of-range");
  }

  if (
    isAddress(intent.seller) &&
    isAddress(intent.buyer) &&
    intent.buyer !== anyBuyer &&
    intent.seller.toLowerCase() === intent.buyer.toLowerCase()
  ) {
    problems.push("seller-is-buyer");
  }

  if (!isAddress(domain.verifyingContract)) problems.push("market-missing");
  if (domain.chainId !== expectedChainId) problems.push("chain-mismatch");

  return problems;
}

/** The typed-data payload handed to `signTypedData`. */
export function saleIntentTypedData(
  intent: SaleIntent,
  domain: SaleIntentDomain,
) {
  return {
    domain: {
      name: saleIntentDomainName,
      version: saleIntentDomainVersion,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: saleIntentTypes,
    primaryType: "SaleIntent",
    message: intent,
  } as const;
}

/**
 * The digest the seller signs, which is also the key the contract records the intent under.
 *
 * Throws rather than returning a digest for terms that would be refused: a hash computed over an
 * invalid intent has no use, and returning one invites signing it.
 */
export function saleIntentHash(
  intent: SaleIntent,
  domain: SaleIntentDomain,
  expectedChainId: number,
): Hex {
  const problems = validateSaleIntent(intent, domain, expectedChainId);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to hash an invalid sale intent: ${problems.join(", ")}`,
    );
  }
  return hashTypedData(saleIntentTypedData(intent, domain));
}

/** Whether `intent` can be filled at `nowSeconds`, given the seller's current on-chain epoch. */
export function saleIntentFillable(
  intent: SaleIntent,
  nowSeconds: number,
  sellerEpoch: bigint,
): {
  fillable: boolean;
  reason: "open" | "not-yet-open" | "expired" | "superseded";
} {
  if (intent.epoch !== sellerEpoch) {
    return { fillable: false, reason: "superseded" };
  }
  if (nowSeconds < intent.startsAt) {
    return { fillable: false, reason: "not-yet-open" };
  }
  if (nowSeconds >= intent.endsAt) {
    return { fillable: false, reason: "expired" };
  }
  return { fillable: true, reason: "open" };
}
