import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionHistoryPagerState } from "@/lib/auction-history-pager";
import type { AuctionHistoryPage } from "@/lib/auction-history-pages";
const harness = vi.hoisted(() => ({ snapshot: null as AuctionHistoryPagerState | null, reads: vi.fn() }));
vi.mock("wagmi", () => ({ usePublicClient: () => ({}) }));
vi.mock("@/lib/wagmi", () => ({ supportedChain: { id: 560048 } }));
vi.mock("@/lib/auction-history-pages", () => ({ readAuctionHistoryPage: harness.reads }));
vi.mock("@/lib/auction-history-pager", () => ({ createAuctionHistoryPager: () => ({ getSnapshot: () => harness.snapshot, getServerSnapshot: () => harness.snapshot, subscribe: () => () => {}, newest: vi.fn(), older: vi.fn(), newer: vi.fn(), retry: vi.fn(), setVisible: vi.fn() }) }));
import { AuctionHistoryBrowser } from "./auction-history-browser";

// Static synthetic read-model display only; not a chain or browser acceptance.
const market = ("0x" + "1".repeat(40)) as `0x${string}`;
const hash = (n: number) => ("0x" + (n+1).toString(16).padStart(64,"0")) as `0x${string}`;
function page(): AuctionHistoryPage {
  return { market, listingId: "7", chainId: 560048, anchorBlock: 2000n, anchorHash: hash(2000), fromBlock: 1001n, toBlock: 2000n, blockSpan: 1000, duplicateCount: 0, older: null, newer: null, entries: Array.from({ length: 130 }, (_, i) => ({ sourceKey: `synthetic:${i}`, event: "BidPlaced", transactionHash: hash(i), blockHash: hash(2000), blockNumber: 2000n, logIndex: i, listingId: "7", actor: market, amount: "12345" })) };
}
const render = () => renderToStaticMarkup(createElement(AuctionHistoryBrowser, { market, listingId: "7" }));
describe("auction history public rendering boundaries", () => {
  beforeEach(() => {
    harness.reads.mockReset();
    harness.snapshot = { phase: "idle", page: null, pending: false, observedAt: null, failure: null };
  });
  it("offers manual public navigation without starting an RPC or requiring a wallet", () => {
    const html = render();
    expect(html).toContain("Read newest page");
    expect(html).toContain("Older blocks");
    expect(html).toContain("Choose Read newest page");
    expect(html).not.toContain("No auction events were returned");
    expect(harness.reads).not.toHaveBeenCalled();
  });
  it("shows provenance and bounds visible event rows without rounding base-unit amounts", () => {
    harness.snapshot = { phase: "ready", page: page(), pending: false, observedAt: 1000, failure: null };
    const html = render();
    expect(html).toContain("Rows 1–50 of 130");
    expect((html.match(/<li>/g) ?? []).length).toBe(50);
    expect(html).toContain("12345");
    expect(html).toContain("Snapshot block");
    expect(html).toContain("1001–2000");
    expect(html).toContain("Order within this page");
    expect(html).toContain("Event type within this page");
    expect(html).toContain("Next rows");
  });
  it.each(["unavailable", "paused", "loading"] as const)("does not render an incompatible stale page while %s", (phase) => {
    harness.snapshot = { phase, page: page(), pending: phase === "loading", observedAt: null, failure: phase === "unavailable" ? "SOURCE_CHANGED" : null };
    const html = render();
    expect(html).not.toContain("Rows 1–50");
    expect(html).not.toContain("Covered blocks");
    expect(html).not.toContain("No auction events were returned");
  });
  it("labels empty successful ranges without claiming outside-page completeness", () => {
    harness.snapshot = { phase: "ready", page: { ...page(), entries: [] }, pending: false, observedAt: 1000, failure: null };
    const html = render();
    expect(html).toContain("No auction events were returned for these covered blocks");
    expect(html).toContain("does not describe blocks outside this page");
  });
});
