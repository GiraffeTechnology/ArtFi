import { hashTypedData, isAddress, type Address, type Hex } from "viem";

/**
 * EIP-712 sale intent for fractions — `PRD.md` §4.2.2, `AGENTS.md` §1.1 invariant 6.
 *
 * The browser half of the fixed-price path in `packages/contracts/src/ArtFiMarket.sol`. The client
 * ruling of 2026-08-30 moved that path off escrow: a holder authorizes a sale by signing terms, and
 * their fractions stay in their own wallet until the fill those terms authorized. There is no
 * resting balance for ArtFi to hold, and no path that moves a holder's tokens without a signature
 * they produced for that fill.
 *
 * The second of the two markets `PRD.md` §1 defines. Whole artwork is model A and settles through
 * `WholeArtworkMarket.sol` (`whole-artwork-intent.ts`, stage `S-WA`); fractions are model B —
 * the ERC-721 mint, vault and ERC-20 fractionalization stack — and settle here, stage `S-FR`.
 *
 * **Partial fills are the difference.** A whole artwork sells once, so its intent is spent or
 * unspent. A fraction authorization names a maximum and is consumed cumulatively, so the same
 * signature can settle several times until the maximum is reached. Everything about remaining
 * amount in this module follows from that.
 *
 * The field order below fixes the EIP-712 type hash and must match `SALE_INTENT_TYPEHASH` in
 * `ArtFiMarket.sol` exactly. The two are not trusted to agree: `FractionSaleIntent.t.sol` and
 * `fraction-intent.test.ts` both assert against the same fixed digest, so a change on either side
 * fails a test rather than producing a signature the market silently rejects.
 */
export const fractionIntentTypes = {
  SaleIntent: [
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
} as const;

export const fractionIntentDomainName = "ArtFi Fractions Market";
export const fractionIntentDomainVersion = "1";

/** Open to any buyer. The contract reads the zero address as "unrestricted". */
export const anyFractionBuyer =
  "0x0000000000000000000000000000000000000000" as const;

export type FractionSaleIntent = {
  seller: Address;
  /** The ERC-20 fraction token. */
  assetToken: Address;
  paymentToken: Address;
  /** The most the seller authorizes in total, across every fill of this signature. */
  maxAmount: bigint;
  /** Price of one fraction, in the payment token's smallest unit. */
  unitPrice: bigint;
  /** `anyFractionBuyer` for an open intent, or the single address allowed to fill. */
  buyer: Address;
  salt: bigint;
  /**
   * Seconds. `uint48` in the contract, so a plain number is exact here — its maximum is far below
   * `Number.MAX_SAFE_INTEGER` — and it is what viem's typed-data encoder expects.
   */
  startsAt: number;
  /** Seconds, exclusive upper bound. `uint48`, as `startsAt`. */
  endsAt: number;
  epoch: bigint;
};

export type FractionIntentDomain = {
  chainId: number;
  /** The deployed `ArtFiMarket`. */
  verifyingContract: Address;
};

/** Every reason an intent is refused before a wallet is ever asked to sign. */
export type FractionIntentProblem =
  | "seller-missing"
  | "asset-token-missing"
  | "payment-token-missing"
  | "buyer-malformed"
  | "max-amount-not-positive"
  | "unit-price-not-positive"
  | "window-not-positive"
  | "window-out-of-range"
  | "salt-negative"
  | "epoch-negative"
  | "seller-is-buyer"
  | "market-missing"
  | "chain-mismatch";

const uint48Max = 281_474_976_710_655;

function addressProblem(
  value: string,
  missing: FractionIntentProblem,
): FractionIntentProblem | null {
  return isAddress(value) ? null : missing;
}

/**
 * Fail-closed validation of the terms the seller is about to authorize.
 *
 * Deliberately stricter than the contract in one place: an intent whose seller is also its named
 * buyer is refused here, so the wallet is never asked to sign terms `fillIntent` would revert on.
 */
export function validateFractionIntent(
  intent: FractionSaleIntent,
  domain: FractionIntentDomain,
  expectedChainId: number,
): FractionIntentProblem[] {
  const problems: FractionIntentProblem[] = [];

  const seller = addressProblem(intent.seller, "seller-missing");
  if (seller) problems.push(seller);
  const assetToken = addressProblem(intent.assetToken, "asset-token-missing");
  if (assetToken) problems.push(assetToken);
  const paymentToken = addressProblem(
    intent.paymentToken,
    "payment-token-missing",
  );
  if (paymentToken) problems.push(paymentToken);
  if (!isAddress(intent.buyer)) problems.push("buyer-malformed");

  if (intent.maxAmount <= 0n) problems.push("max-amount-not-positive");
  if (intent.unitPrice <= 0n) problems.push("unit-price-not-positive");
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
    intent.buyer !== anyFractionBuyer &&
    intent.seller.toLowerCase() === intent.buyer.toLowerCase()
  ) {
    problems.push("seller-is-buyer");
  }

  if (!isAddress(domain.verifyingContract)) problems.push("market-missing");
  if (domain.chainId !== expectedChainId) problems.push("chain-mismatch");

  return problems;
}

/** The typed-data payload handed to `signTypedData`. */
export function fractionIntentTypedData(
  intent: FractionSaleIntent,
  domain: FractionIntentDomain,
) {
  return {
    domain: {
      name: fractionIntentDomainName,
      version: fractionIntentDomainVersion,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: fractionIntentTypes,
    primaryType: "SaleIntent",
    message: intent,
  } as const;
}

/**
 * The digest the seller signs, which is also the key the contract counts fills under.
 *
 * Throws rather than returning a digest for terms that would be refused: a hash computed over an
 * invalid intent has no use, and returning one invites signing it.
 */
export function fractionIntentHash(
  intent: FractionSaleIntent,
  domain: FractionIntentDomain,
  expectedChainId: number,
): Hex {
  const problems = validateFractionIntent(intent, domain, expectedChainId);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to hash an invalid fraction sale intent: ${problems.join(", ")}`,
    );
  }
  return hashTypedData(fractionIntentTypedData(intent, domain));
}

/** What the contract will still accept against this signature. */
export function fractionIntentRemaining(
  intent: FractionSaleIntent,
  alreadyFilled: bigint,
): bigint {
  return alreadyFilled >= intent.maxAmount
    ? 0n
    : intent.maxAmount - alreadyFilled;
}

export type FractionFillReason =
  | "open"
  | "not-yet-open"
  | "expired"
  | "superseded"
  | "exhausted"
  | "amount-not-positive"
  | "amount-exceeds-remaining";

/**
 * Whether `amount` of `intent` can be settled now.
 *
 * Checked in the order the contract checks, so the reason a fill is refused here is the reason it
 * would be refused on chain. `exhausted` and `amount-exceeds-remaining` are distinct on purpose: a
 * signature with nothing left is finished, while one with less left than asked can still settle a
 * smaller amount, and a buyer is entitled to know which of the two they are looking at.
 *
 * A revocation on chain sets the fill counter to the maximum, so a revoked authorization reads as
 * `exhausted` here without this module needing to know revocation exists.
 */
export function fractionIntentFillable(
  intent: FractionSaleIntent,
  nowSeconds: number,
  sellerEpoch: bigint,
  alreadyFilled: bigint,
  amount: bigint,
): { fillable: boolean; reason: FractionFillReason; remaining: bigint } {
  const remaining = fractionIntentRemaining(intent, alreadyFilled);
  const refuse = (reason: FractionFillReason) => ({
    fillable: false,
    reason,
    remaining,
  });

  if (intent.epoch !== sellerEpoch) return refuse("superseded");
  if (nowSeconds < intent.startsAt) return refuse("not-yet-open");
  if (nowSeconds >= intent.endsAt) return refuse("expired");
  if (remaining === 0n) return refuse("exhausted");
  if (amount <= 0n) return refuse("amount-not-positive");
  if (amount > remaining) return refuse("amount-exceeds-remaining");
  return { fillable: true, reason: "open", remaining };
}

/** What the buyer pays for `amount` fractions. The contract computes the same product. */
export function fractionFillPayment(
  intent: FractionSaleIntent,
  amount: bigint,
): bigint {
  return amount * intent.unitPrice;
}
