import { describe, expect, it } from "vitest";

import {
  anyBuyer,
  saleIntentFillable,
  saleIntentHash,
  saleIntentTypedData,
  saleIntentTypes,
  type SaleIntent,
  type SaleIntentDomain,
  validateSaleIntent,
} from "./whole-artwork-intent";

const chainId = 560048;

const domain: SaleIntentDomain = {
  chainId,
  verifyingContract: "0x00000000000000000000000000000000000000a1",
};

const intent: SaleIntent = {
  seller: "0x000000000000000000000000000000000000beef",
  collection: "0x00000000000000000000000000000000000000c0",
  tokenId: 7n,
  paymentToken: "0x00000000000000000000000000000000000000d0",
  price: 1234567890n,
  buyer: anyBuyer,
  salt: 42n,
  startsAt: 1000,
  endsAt: 2000,
  epoch: 3n,
};

describe("saleIntentHash", () => {
  // The same fixed intent, domain and digest are asserted in
  // packages/contracts/test/WholeArtworkMarket.t.sol::testDigestMatchesTheBrowserSigner, where
  // the value is rebuilt from the contract's own SALE_INTENT_TYPEHASH. A field renamed, reordered
  // or retyped on either side breaks this constant on both, rather than shipping a signature the
  // market rejects at fill time.
  it("produces the digest the contract verifies against", () => {
    expect(saleIntentHash(intent, domain, chainId)).toBe(
      "0x29a4beddf736f69c2e0f72fed58c67d79b4a671bfdcc7729cd081318f64340b7",
    );
  });

  it("changes when any signed term changes", () => {
    const base = saleIntentHash(intent, domain, chainId);
    const terms: Array<Partial<SaleIntent>> = [
      { price: 1234567891n },
      { tokenId: 8n },
      { buyer: "0x000000000000000000000000000000000000dead" },
      { endsAt: 2001 },
      { epoch: 4n },
      { salt: 43n },
    ];
    for (const change of terms) {
      expect(
        saleIntentHash({ ...intent, ...change }, domain, chainId),
      ).not.toBe(base);
    }
  });

  // A signature is bound to one deployment. Replaying it against another chain or another market
  // address must not verify.
  it("is bound to the chain and the market address", () => {
    const otherChain = { ...domain, chainId: 11155111 };
    expect(saleIntentHash(intent, otherChain, 11155111)).not.toBe(
      saleIntentHash(intent, domain, chainId),
    );
    const otherMarket: SaleIntentDomain = {
      ...domain,
      verifyingContract: "0x00000000000000000000000000000000000000a2",
    };
    expect(saleIntentHash(intent, otherMarket, chainId)).not.toBe(
      saleIntentHash(intent, domain, chainId),
    );
  });

  // Hashing invalid terms would hand the caller something signable. Refuse instead.
  it("refuses to hash terms it would not sign", () => {
    expect(() =>
      saleIntentHash({ ...intent, price: 0n }, domain, chainId),
    ).toThrow(/price-not-positive/);
    expect(() => saleIntentHash(intent, domain, 1)).toThrow(/chain-mismatch/);
  });
});

describe("validateSaleIntent", () => {
  it("accepts well-formed terms", () => {
    expect(validateSaleIntent(intent, domain, chainId)).toEqual([]);
  });

  it("rejects a non-positive price", () => {
    expect(
      validateSaleIntent({ ...intent, price: 0n }, domain, chainId),
    ).toContain("price-not-positive");
  });

  it("rejects an empty or inverted fill window", () => {
    expect(
      validateSaleIntent(
        { ...intent, endsAt: intent.startsAt },
        domain,
        chainId,
      ),
    ).toContain("window-not-positive");
    expect(
      validateSaleIntent({ ...intent, endsAt: 999 }, domain, chainId),
    ).toContain("window-not-positive");
  });

  // uint48 in the contract. A larger value would be silently truncated on the way in.
  it("rejects a window that does not fit the contract's uint48", () => {
    expect(
      validateSaleIntent(
        { ...intent, endsAt: 281_474_976_710_656 },
        domain,
        chainId,
      ),
    ).toContain("window-out-of-range");
  });

  it("rejects malformed addresses", () => {
    expect(
      validateSaleIntent(
        { ...intent, seller: "0xnope" as never },
        domain,
        chainId,
      ),
    ).toContain("seller-missing");
    expect(
      validateSaleIntent(
        { ...intent, collection: "" as never },
        domain,
        chainId,
      ),
    ).toContain("collection-missing");
    expect(
      validateSaleIntent(
        { ...intent, paymentToken: "0x00" as never },
        domain,
        chainId,
      ),
    ).toContain("payment-token-missing");
  });

  /**
   * The zero address is a valid address and not a valid party or token. A signature over it could
   * never settle, so the wallet is not asked to produce one.
   */
  it("rejects the zero address as a party or a token", () => {
    const cases: Array<[Partial<SaleIntent>, string]> = [
      [
        { seller: "0x0000000000000000000000000000000000000000" },
        "seller-missing",
      ],
      [
        { collection: "0x0000000000000000000000000000000000000000" },
        "collection-missing",
      ],
      [
        { paymentToken: "0x0000000000000000000000000000000000000000" },
        "payment-token-missing",
      ],
    ];
    for (const [change, problem] of cases) {
      expect(
        validateSaleIntent({ ...intent, ...change }, domain, chainId),
      ).toContain(problem);
    }
  });

  // The one field where it is meaningful: the contract reads a zero buyer as "anyone may fill".
  it("still accepts the zero address as an open buyer", () => {
    expect(
      validateSaleIntent(
        { ...intent, buyer: "0x0000000000000000000000000000000000000000" },
        domain,
        chainId,
      ),
    ).toEqual([]);
  });

  it("rejects an unconfigured market address", () => {
    expect(
      validateSaleIntent(
        intent,
        { ...domain, verifyingContract: "" as never },
        chainId,
      ),
    ).toContain("market-missing");
  });

  // fillIntent reverts with SellerMayNotBuy. Catching it here means the wallet is never asked to
  // sign terms that cannot settle.
  it("rejects an intent naming the seller as its own buyer", () => {
    expect(
      validateSaleIntent({ ...intent, buyer: intent.seller }, domain, chainId),
    ).toContain("seller-is-buyer");
  });

  it("does not mistake an open intent for a self-deal", () => {
    expect(
      validateSaleIntent({ ...intent, buyer: anyBuyer }, domain, chainId),
    ).toEqual([]);
  });

  it("reports every problem at once rather than the first", () => {
    const problems = validateSaleIntent(
      { ...intent, price: 0n, endsAt: intent.startsAt },
      domain,
      1,
    );
    expect(problems).toContain("price-not-positive");
    expect(problems).toContain("window-not-positive");
    expect(problems).toContain("chain-mismatch");
  });
});

describe("saleIntentTypedData", () => {
  it("names the domain the contract declares", () => {
    const typedData = saleIntentTypedData(intent, domain);
    expect(typedData.domain.name).toBe("ArtFi Whole Artwork Market");
    expect(typedData.domain.version).toBe("1");
    expect(typedData.domain.chainId).toBe(chainId);
    expect(typedData.primaryType).toBe("SaleIntent");
  });

  // The struct's field order is part of the type hash, so it is asserted, not assumed.
  it("keeps the field order the type hash depends on", () => {
    expect(saleIntentTypes.SaleIntent.map((field) => field.name)).toEqual([
      "seller",
      "collection",
      "tokenId",
      "paymentToken",
      "price",
      "buyer",
      "salt",
      "startsAt",
      "endsAt",
      "epoch",
    ]);
  });
});

describe("saleIntentFillable", () => {
  it("is open inside the window at the current epoch", () => {
    expect(saleIntentFillable(intent, 1500, 3n)).toEqual({
      fillable: true,
      reason: "open",
    });
  });

  it("treats startsAt as inclusive and endsAt as exclusive, matching the contract", () => {
    expect(saleIntentFillable(intent, 1000, 3n).fillable).toBe(true);
    expect(saleIntentFillable(intent, 999, 3n)).toEqual({
      fillable: false,
      reason: "not-yet-open",
    });
    expect(saleIntentFillable(intent, 2000, 3n)).toEqual({
      fillable: false,
      reason: "expired",
    });
  });

  // An epoch bump revokes in bulk on chain. The UI must say so rather than offering a fill that
  // would revert.
  it("reports an intent left behind by an epoch bump as superseded", () => {
    expect(saleIntentFillable(intent, 1500, 4n)).toEqual({
      fillable: false,
      reason: "superseded",
    });
  });

  it("puts the epoch check ahead of the clock", () => {
    expect(saleIntentFillable(intent, 5000, 4n).reason).toBe("superseded");
  });
});
