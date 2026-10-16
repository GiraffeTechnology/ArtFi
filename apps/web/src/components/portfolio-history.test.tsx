import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PortfolioEntry } from "@/lib/portfolio-records-state";
import { PortfolioHistory } from "./portfolio-history";

describe("private loaded history controls", () => {
  it("labels bounded filters and disabled empty pagination", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioHistory, { entries: [] }),
    );
    expect(html).toContain("History status");
    expect(html).toContain("History event");
    expect(html).toContain("History order");
    expect(html).toContain("only to the loaded indexed records");
    expect(html).toContain(
      "No indexed transaction is associated with this address.",
    );
    expect(html).toContain("Page 1 of 1");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it("renders exact source identity and reorg supersession without fixture substitution", () => {
    const record: PortfolioEntry = {
      id: "560048:log:1",
      transactionHash: `0x${"a".repeat(64)}`,
      contractAddress: `0x${"b".repeat(40)}`,
      eventName: "IntentFilled",
      blockNumber: 4,
      logIndex: 1,
      status: "removed",
      observedAt: "2026-10-16T12:00:00Z",
    };
    const html = renderToStaticMarkup(
      createElement(PortfolioHistory, { entries: [record] }),
    );
    expect(html).toContain(record.transactionHash);
    expect(html).toContain(record.contractAddress);
    expect(html).toContain("previous confirmation no longer applies");
    expect(html).toContain('datetime="2026-10-16T12:00:00Z"');
  });
  it("renders unavailable history instead of a partial malformed result", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioHistory, { entries: [null] as never }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Indexed history is unavailable.");
    expect(html).not.toContain("No indexed transaction is associated");
  });
});
