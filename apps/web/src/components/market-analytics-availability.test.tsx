import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketAnalyticsAvailability } from "./market-analytics-availability";

describe("market analytics availability", () => {
  it("labels each unsupported runtime dataset unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(MarketAnalyticsAvailability),
    );

    expect(html).toContain("Runtime analytics are unavailable");
    expect(html).toContain("Price history");
    expect(html).toContain("Holder distribution");
    expect(html).toContain("Transaction analytics");
    expect(
      html.match(/Unavailable from an attributed runtime source\./g),
    ).toHaveLength(3);
  });

  it("warns that prototype figures are not current market state", () => {
    const html = renderToStaticMarkup(
      createElement(MarketAnalyticsAvailability),
    );

    expect(html).toContain(
      "Catalogue figures above are prototype data and must not be read as current market state.",
    );
    expect(html).toContain(
      "No fixture, estimate, or historical snapshot is presented as live.",
    );
  });
});
