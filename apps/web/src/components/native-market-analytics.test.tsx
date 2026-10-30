import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeMarketAnalyticsPanel } from "./native-market-analytics";
import { analyticsAssetFixture } from "../test/native-market-analytics-fixture";
describe("source-bound market analytics surface", () => {
  it("requires an explicit currency selection and never renders sample totals", () => {
    const html = renderToStaticMarkup(
      createElement(NativeMarketAnalyticsPanel, {
        asset: analyticsAssetFixture(),
      }),
    );
    expect(html).toContain("Payment-token address");
    expect(html).toContain("Read indexed analytics");
    expect(html).toContain("disabled");
    expect(html).toContain("not a valuation");
    expect(html).not.toContain("27021597764222979");
  });
  it("keeps whole receipts distinct from the implemented fractional series", () => {
    const asset = analyticsAssetFixture();
    asset.section = "whole";
    expect(
      renderToStaticMarkup(
        createElement(NativeMarketAnalyticsPanel, { asset }),
      ),
    ).toBe("");
  });
  it("explains a missing source binding without supplying environment addresses", () => {
    const asset = analyticsAssetFixture();
    asset.binding.marketAddress = undefined;
    const html = renderToStaticMarkup(
      createElement(NativeMarketAnalyticsPanel, { asset }),
    );
    expect(html).toContain("no supported native fraction market binding");
    expect(html).not.toContain("<form");
  });
});
