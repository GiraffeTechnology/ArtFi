import { describe, expect, it } from "vitest";
import {
  analyticsAssetFixture,
  analyticsPaymentToken,
  nativeAnalyticsFixture,
} from "../test/native-market-analytics-fixture";
import {
  nativeAnalyticsScope,
  parseNativeAnalyticsEnvelope,
  parseNativeMarketAnalytics,
} from "./native-market-analytics";
import { rwaAssetIdentity } from "./rwa-catalog";
const scope = () =>
  nativeAnalyticsScope(analyticsAssetFixture(), analyticsPaymentToken);
describe("source-bound native market analytics contract", () => {
  it("preserves full-width amounts and block identity without numeric coercion", () => {
    const value = nativeAnalyticsFixture();
    const result = parseNativeMarketAnalytics(value, scope());
    expect(result.priceHistory[0]!.unitPrice).toBe("9007199254740993");
    expect(result.payment).toBe("27021597764222979");
    expect(result.priceHistory[0]!.blockNumber).toBe("9007199254740993");
    expect(result.coverage).toContain("not_complete");
    expect(result.holderDistribution).toBeNull();
  });
  it.each(["marketAddress", "assetToken", "paymentToken", "chainId"])(
    "refuses another %s rather than relabeling it",
    (field) => {
      const value = {
        ...nativeAnalyticsFixture(),
        [field]: field === "chainId" ? 1 : "0x" + "a".repeat(40),
      };
      expect(() => parseNativeMarketAnalytics(value, scope())).toThrow();
    },
  );
  it.each(["unitPrice", "quantity", "payment", "blockNumber"])(
    "refuses unsafe numeric %s and noncanonical decimal strings",
    (field) => {
      const value = nativeAnalyticsFixture();
      Object.assign(value.priceHistory[0]!, { [field]: 9007199254740993 });
      expect(() => parseNativeMarketAnalytics(value, scope())).toThrow();
      Object.assign(value.priceHistory[0]!, { [field]: "01" });
      expect(() => parseNativeMarketAnalytics(value, scope())).toThrow();
    },
  );
  it("refuses inconsistent multiplication, aggregate totals and duplicate logs", () => {
    const badPrice = nativeAnalyticsFixture();
    badPrice.priceHistory[0]!.payment = "1";
    expect(() => parseNativeMarketAnalytics(badPrice, scope())).toThrow();
    const badTotal = nativeAnalyticsFixture();
    badTotal.payment = "1";
    expect(() => parseNativeMarketAnalytics(badTotal, scope())).toThrow();
    const duplicate = nativeAnalyticsFixture();
    duplicate.priceHistory.push(structuredClone(duplicate.priceHistory[0]!));
    duplicate.tradeCount = 2;
    expect(() => parseNativeMarketAnalytics(duplicate, scope())).toThrow();
  });
  it("refuses invented holder distributions and expanded evidence authority", () => {
    for (const extra of [
      { holderDistribution: [] },
      { coverage: "complete" },
      { finality: "final" },
      { operationAuthority: "approved" },
    ])
      expect(() =>
        parseNativeMarketAnalytics(
          { ...nativeAnalyticsFixture(), ...extra },
          scope(),
        ),
      ).toThrow();
  });
  it("accepts unavailable projections only without displayed totals or price observations", () => {
    const value = {
      ...nativeAnalyticsFixture(),
      status: "history_limit_exceeded",
      quantity: null,
      payment: null,
      tradeCount: 0,
      distinctParticipants: 0,
      priceHistory: [],
    };
    expect(parseNativeMarketAnalytics(value, scope()).quantity).toBeNull();
    expect(() =>
      parseNativeMarketAnalytics({ ...value, payment: "1" }, scope()),
    ).toThrow();
  });
  it("requires the catalog identity and revision used by the visible source record", () => {
    const asset = analyticsAssetFixture();
    const expected = {
      scope: scope(),
      catalogIdentity: rwaAssetIdentity(asset),
      catalogRevision: asset.revision,
    };
    expect(
      parseNativeAnalyticsEnvelope(
        {
          catalogIdentity: expected.catalogIdentity,
          catalogRevision: expected.catalogRevision,
          analytics: nativeAnalyticsFixture(),
        },
        expected,
      ),
    ).toBeDefined();
  });
  it("retires a foreign or revised source response", () => {
    const asset = analyticsAssetFixture(),
      expected = {
        scope: scope(),
        catalogIdentity: rwaAssetIdentity(asset),
        catalogRevision: 1,
      };
    for (const envelope of [
      { catalogIdentity: "foreign", catalogRevision: 1 },
      { catalogIdentity: expected.catalogIdentity, catalogRevision: 2 },
    ])
      expect(() =>
        parseNativeAnalyticsEnvelope(
          { ...envelope, analytics: nativeAnalyticsFixture() },
          expected,
        ),
      ).toThrow("source record changed");
  });
  it("allows public historical reads after grounding revocation without creating trading authority", () => {
    const asset = analyticsAssetFixture();
    asset.grounding.status = "revoked";
    expect(nativeAnalyticsScope(asset, analyticsPaymentToken)).toEqual(scope());
  });
  it("refuses unsupported or absent native bindings and does not guess a currency", () => {
    const asset = analyticsAssetFixture();
    expect(() => nativeAnalyticsScope(asset, "")).toThrow("payment-token");
    expect(() =>
      nativeAnalyticsScope(asset, asset.binding.fractionTokenAddress!),
    ).toThrow();
    asset.binding.marketAddress = undefined;
    expect(() => nativeAnalyticsScope(asset, analyticsPaymentToken)).toThrow(
      "unavailable",
    );
  });
});
