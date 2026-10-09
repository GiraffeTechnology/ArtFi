import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PortfolioDetails } from "./portfolio-records";
import type { Portfolio } from "@/lib/portfolio-records-state";
vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("./user-session-provider", () => ({ useUserSession: vi.fn() }));
const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const currency = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const portfolio = (): Portfolio => ({
  address,
  chainId: 560048,
  network: "hoodi",
  positions: [],
  transactions: [],
  offers: [],
  notifications: [
    {
      id: "560048:transaction:1",
      transactionHash: `0x${"1".repeat(64)}`,
      logIndex: 1,
      contractAddress: address,
      eventName: "IntentFilled",
      blockNumber: 1,
      status: "removed",
      observedAt: "2026-10-05T12:00:00Z",
      message: "Previous confirmation no longer applies.",
    },
  ],
  performance: {
    status: "known_for_indexed_history",
    method: "fifo",
    scope: "confirmed_indexed_fraction_trades",
    unmappedTradeCount: 0,
    pendingEventCount: 0,
    reasons: [],
    items: [
      {
        assetToken: address,
        paymentToken: currency,
        confirmedQuantity: "900719925474099300000001",
        costBasis: "1801439850948198600000002",
        realizedPnl: "-1",
        status: "known",
        buyCount: 1,
        sellCount: 1,
        reasons: [],
      },
    ],
  },
});
describe("private portfolio P&L and notifications rendering", () => {
  it("renders exact large quantities, negative P&L, currency and source limits", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioDetails, { portfolio: portfolio() }),
    );
    expect(html).toContain("900719925474099300000001");
    expect(html).toContain(
      "1801439850948198600000002 payment-token base units",
    );
    expect(html).toContain("-1 payment-token base units");
    expect(html).toContain(currency);
    expect(html).toContain("without gas costs or fiat conversion");
    expect(html).toContain("unrealized P&amp;L are unknown");
  });
  it("does not turn missing or incomplete basis into zero", () => {
    const value = portfolio();
    value.performance!.items[0] = {
      ...value.performance!.items[0],
      status: "unknown",
      costBasis: null,
      realizedPnl: null,
      reasons: ["Unmatched transfer."],
    };
    const html = renderToStaticMarkup(
      createElement(PortfolioDetails, { portfolio: value }),
    );
    expect(html).toContain("Remaining cost basis: Unknown");
    expect(html).toContain("Realized P&amp;L: Unknown");
    expect(html).toContain("Unmatched transfer.");
    delete value.performance;
    expect(
      renderToStaticMarkup(
        createElement(PortfolioDetails, { portfolio: value }),
      ),
    ).toContain("Performance evidence is unavailable. P&amp;L is unknown.");
  });
  it("shows removed notification evidence and its stable log identity", () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioDetails, { portfolio: portfolio() }),
    );
    expect(html).toContain("IntentFilled · removed");
    expect(html).toContain("Previous confirmation no longer applies.");
    expect(html).toContain("log 1");
    expect(html).toContain("Last indexed update:");
  });
  it("reports empty notifications and no calculation without pretending a return", () => {
    const value = portfolio();
    value.notifications = [];
    value.performance!.items = [];
    value.performance!.status = "no_indexed_history";
    const html = renderToStaticMarkup(
      createElement(PortfolioDetails, { portfolio: value }),
    );
    expect(html).toContain("No indexed wallet notification is available.");
    expect(html).toContain(
      "No supported performance calculation is available.",
    );
  });
});
