import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  IndexedHistoryEntries,
  PortfolioIndexedHistory,
} from "./portfolio-indexed-history";
import {
  initialIndexedHistoryFilter as initial,
  readIndexedHistoryPage,
} from "@/lib/portfolio-indexed-history";

const owner = "0x1000000000000000000000000000000000000001";
const hash = "0x" + "1".repeat(64);
function page(status: "pending" | "confirmed" | "removed") {
  return readIndexedHistoryPage(
    {
      address: owner,
      chainId: 560048,
      scope: "indexed_chain_events",
      filters: { ...initial },
      pageSize: 10,
      total: 1,
      data: [
        {
          id: `560048:${hash}:0`,
          transactionHash: hash,
          contractAddress: owner,
          eventName: "TEST_ONLY_Event",
          blockNumber: 1000,
          logIndex: 0,
          status,
          observedAt: "2026-10-28T00:00:00Z",
        },
      ],
    },
    owner,
    initial,
  );
}
describe("all indexed history presentation", () => {
  it("keeps the initial server view loading and discloses index and snapshot limits", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioIndexedHistory, { address: owner }),
    );
    expect(html).toContain("Reading indexed transaction history");
    expect(html).toContain(
      "not a complete blockchain scan or evidence of property rights",
    );
    expect(html).not.toContain("No indexed event was returned");
    const label = html.match(
      /<label for="([^"]+)">Indexed history status<\/label>/,
    );
    expect(label).not.toBeNull();
    expect(html).toContain(`<select id="${label![1]}"`);
  });
  it.each(["pending", "confirmed", "removed"] as const)(
    "shows exact %s indexed evidence and preserves identifiers",
    (status) => {
      const html = renderToStaticMarkup(
        createElement(IndexedHistoryEntries, { page: page(status) }),
      );
      expect(html).toContain(hash);
      expect(html).toContain("data-no-translate");
      expect(html).toContain("TEST_ONLY_Event");
      expect(html).toContain(
        status === "removed"
          ? "earlier indexed confirmation no longer applies"
          : status === "confirmed"
            ? "Confirmed in the indexed observation"
            : "Confirmation is pending in the index",
      );
    },
  );
  it("does not label an empty later page as absence of every wallet transaction", () => {
    const filter = { ...initial, page: 11 };
    const value = readIndexedHistoryPage(
      {
        address: owner,
        chainId: 560048,
        scope: "indexed_chain_events",
        filters: filter,
        pageSize: 10,
        total: 0,
        data: [],
      },
      owner,
      filter,
    );
    const html = renderToStaticMarkup(
      createElement(IndexedHistoryEntries, { page: value }),
    );
    expect(html).toContain("No indexed event was returned on this page");
    expect(html).not.toContain("You have no transactions");
  });
});
