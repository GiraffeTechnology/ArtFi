import { describe, expect, it } from "vitest";

import {
  anyFractionBuyer,
  fractionFillPayment,
  fractionIntentFillable,
  fractionIntentHash,
  fractionIntentRemaining,
  fractionIntentTypedData,
  fractionIntentTypes,
  type FractionIntentDomain,
  type FractionSaleIntent,
  validateFractionIntent,
} from "./fraction-intent";

const chainId = 560048;

const domain: FractionIntentDomain = {
  chainId,
  verifyingContract: "0x00000000000000000000000000000000000000a1",
};

const intent: FractionSaleIntent = {
  seller: "0x000000000000000000000000000000000000beef",
  assetToken: "0x00000000000000000000000000000000000000c0",
  paymentToken: "0x00000000000000000000000000000000000000d0",
  maxAmount: 1000n,
  unitPrice: 1234567890n,
  buyer: anyFractionBuyer,
  salt: 42n,
  startsAt: 1000,
  endsAt: 2000,
  epoch: 3n,
};

describe("fractionIntentHash", () => {
  // The same fixed intent, domain and digest are asserted in
  // packages/contracts/test/FractionSaleIntent.t.sol::testDigestMatchesTheBrowserSigner, where the
  // value is rebuilt from the contract's own SALE_INTENT_TYPEHASH. A field renamed, reordered or
  // retyped on either side breaks this constant on both, rather than shipping a signature the
  // market rejects at fill time.
  it("produces the digest the contract verifies against", () => {
    expect(fractionIntentHash(intent, domain, chainId)).toBe(
      "0x9de0ca5c018685d7054b96dbce27834375413de39e1ec02bdcbb5862acde3cbf",
    );
  });

  it("changes when any signed term changes", () => {
    const base = fractionIntentHash(intent, domain, chainId);
    const terms: Array<Partial<FractionSaleIntent>> = [
      { maxAmount: 1001n },
      { unitPrice: 1234567891n },
      { assetToken: "0x00000000000000000000000000000000000000c1" },
      { paymentToken: "0x00000000000000000000000000000000000000d1" },
      { buyer: "0x000000000000000000000000000000000000dead" },
      { startsAt: 1001 },
      { endsAt: 2001 },
      { epoch: 4n },
      { salt: 43n },
    ];
    for (const change of terms) {
      expect(
        fractionIntentHash({ ...intent, ...change }, domain, chainId),
      ).not.toBe(base);
    }
  });

  // A signature is bound to one deployment. Replaying it against another chain or another market
  // address must not verify.
  it("is bound to the chain and the market address", () => {
    const otherChain = { ...domain, chainId: 11155111 };
    expect(fractionIntentHash(intent, otherChain, 11155111)).not.toBe(
      fractionIntentHash(intent, domain, chainId),
    );
    const otherMarket: FractionIntentDomain = {
      ...domain,
      verifyingContract: "0x00000000000000000000000000000000000000a2",
    };
    expect(fractionIntentHash(intent, otherMarket, chainId)).not.toBe(
      fractionIntentHash(intent, domain, chainId),
    );
  });

  // A hash over terms the market would refuse has no use, and returning one invites signing it.
  it("refuses to hash terms the market would reject", () => {
    expect(() =>
      fractionIntentHash({ ...intent, unitPrice: 0n }, domain, chainId),
    ).toThrow(/unit-price-not-positive/);
    expect(() =>
      fractionIntentHash({ ...intent, maxAmount: 0n }, domain, chainId),
    ).toThrow(/max-amount-not-positive/);
  });
});

describe("fractionIntentTypedData", () => {
  it("carries the domain and field order the contract expects", () => {
    const payload = fractionIntentTypedData(intent, domain);
    expect(payload.domain.name).toBe("ArtFi Fractions Market");
    expect(payload.domain.version).toBe("1");
    expect(payload.primaryType).toBe("SaleIntent");
    expect(fractionIntentTypes.SaleIntent.map((field) => field.name)).toEqual([
      "seller",
      "assetToken",
      "paymentToken",
      "maxAmount",
      "unitPrice",
      "buyer",
      "salt",
      "startsAt",
      "endsAt",
      "epoch",
    ]);
  });
});

describe("validateFractionIntent", () => {
  it("accepts terms the market accepts", () => {
    expect(validateFractionIntent(intent, domain, chainId)).toEqual([]);
  });

  it("names every malformed address rather than the first", () => {
    expect(
      validateFractionIntent(
        {
          ...intent,
          seller: "not-an-address" as FractionSaleIntent["seller"],
          assetToken: "0x00" as FractionSaleIntent["assetToken"],
          paymentToken: "" as FractionSaleIntent["paymentToken"],
        },
        domain,
        chainId,
      ),
    ).toEqual([
      "seller-missing",
      "asset-token-missing",
      "payment-token-missing",
    ]);
  });

  it("rejects a window that does not open", () => {
    expect(
      validateFractionIntent({ ...intent, endsAt: 1000 }, domain, chainId),
    ).toContain("window-not-positive");
  });

  it("rejects a window outside the contract's uint48 range", () => {
    expect(
      validateFractionIntent(
        { ...intent, endsAt: 281_474_976_710_656 },
        domain,
        chainId,
      ),
    ).toContain("window-out-of-range");
  });

  // Stricter than the contract on purpose: the wallet is never asked to sign terms `fillIntent`
  // reverts on with `SellerMayNotBuy`.
  it("refuses a seller who names themselves as the buyer", () => {
    expect(
      validateFractionIntent(
        { ...intent, buyer: intent.seller },
        domain,
        chainId,
      ),
    ).toContain("seller-is-buyer");
  });

  it("allows the open-buyer zero address", () => {
    expect(
      validateFractionIntent(
        { ...intent, buyer: anyFractionBuyer },
        domain,
        chainId,
      ),
    ).toEqual([]);
  });

  it("reports an unconfigured market and the wrong chain", () => {
    const problems = validateFractionIntent(
      intent,
      {
        chainId: 1,
        verifyingContract: "nope" as FractionIntentDomain["verifyingContract"],
      },
      chainId,
    );
    expect(problems).toContain("market-missing");
    expect(problems).toContain("chain-mismatch");
  });
});

describe("fractionIntentRemaining", () => {
  it("counts down from the authorized maximum", () => {
    expect(fractionIntentRemaining(intent, 0n)).toBe(1000n);
    expect(fractionIntentRemaining(intent, 400n)).toBe(600n);
    expect(fractionIntentRemaining(intent, 1000n)).toBe(0n);
  });

  // A revocation sets the counter to the maximum, and a counter past it must not underflow into a
  // huge remaining amount.
  it("never reports a negative remainder", () => {
    expect(fractionIntentRemaining(intent, 1001n)).toBe(0n);
  });
});

describe("fractionIntentFillable", () => {
  const openAt = 1500;

  it("settles a partial amount inside the window", () => {
    expect(fractionIntentFillable(intent, openAt, 3n, 250n, 100n)).toEqual({
      fillable: true,
      reason: "open",
      remaining: 750n,
    });
  });

  it("refuses before the window opens and after it closes", () => {
    expect(fractionIntentFillable(intent, 999, 3n, 0n, 1n).reason).toBe(
      "not-yet-open",
    );
    expect(fractionIntentFillable(intent, 2000, 3n, 0n, 1n).reason).toBe(
      "expired",
    );
  });

  // The seller bumped their epoch, so every signature against the old one is dead. This outranks
  // the window, as it does in the contract.
  it("refuses a superseded epoch before anything else", () => {
    expect(fractionIntentFillable(intent, 999, 4n, 0n, 1n).reason).toBe(
      "superseded",
    );
  });

  it("distinguishes an exhausted authorization from one asked for too much", () => {
    expect(fractionIntentFillable(intent, openAt, 3n, 1000n, 1n).reason).toBe(
      "exhausted",
    );
    expect(fractionIntentFillable(intent, openAt, 3n, 900n, 200n)).toEqual({
      fillable: false,
      reason: "amount-exceeds-remaining",
      remaining: 100n,
    });
  });

  it("refuses a zero or negative amount", () => {
    expect(fractionIntentFillable(intent, openAt, 3n, 0n, 0n).reason).toBe(
      "amount-not-positive",
    );
    expect(fractionIntentFillable(intent, openAt, 3n, 0n, -1n).reason).toBe(
      "amount-not-positive",
    );
  });

  it("reports the remaining amount even when it refuses", () => {
    expect(fractionIntentFillable(intent, 2000, 3n, 250n, 100n).remaining).toBe(
      750n,
    );
  });
});

describe("fractionFillPayment", () => {
  // The same product the contract computes, in the payment token's smallest unit. Exact in bigint,
  // which is why the surface never converts a price to a number.
  it("multiplies the unit price by the amount", () => {
    expect(fractionFillPayment(intent, 3n)).toBe(3703703670n);
    expect(fractionFillPayment(intent, 0n)).toBe(0n);
  });

  it("stays exact past the safe-integer range", () => {
    const large: FractionSaleIntent = {
      ...intent,
      unitPrice: 10n ** 18n,
      maxAmount: 10n ** 9n,
    };
    expect(fractionFillPayment(large, 10n ** 9n)).toBe(10n ** 27n);
  });
});
