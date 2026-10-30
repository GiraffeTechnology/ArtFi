import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicBlockHistoryPagerState } from "@/lib/public-block-history-pager";
import type { AuctionDiscoveryPage } from "@/lib/auction-discovery-pages";
const harness = vi.hoisted(() => ({
  snapshot: null as PublicBlockHistoryPagerState<AuctionDiscoveryPage> | null,
  reads: vi.fn(),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => ({}) }));
vi.mock("@/lib/wagmi", () => ({ supportedChain: { id: 560048 } }));
vi.mock("@/lib/auction-discovery-pages", () => ({
  readAuctionDiscoveryPage: harness.reads,
}));
vi.mock("@/lib/public-block-history-pager", () => ({
  createPublicBlockHistoryPager: () => ({
    getSnapshot: () => harness.snapshot,
    getServerSnapshot: () => harness.snapshot,
    subscribe: () => () => {},
    newest: vi.fn(),
    older: vi.fn(),
    newer: vi.fn(),
    retry: vi.fn(),
    setVisible: vi.fn(),
  }),
}));
import { AuctionDiscoveryBrowser } from "./auction-discovery-browser";

// Synthetic static display only, distinct from browser and live RPC acceptance.
const market = ("0x" + "1".repeat(40)) as `0x${string}`;
const hash = (n: number) =>
  ("0x" + (n + 1).toString(16).padStart(64, "0")) as `0x${string}`;
function page(): AuctionDiscoveryPage {
  return {
    market,
    seller: null,
    chainId: 560048,
    anchorBlock: 20000n,
    anchorHash: hash(20000),
    fromBlock: 19001n,
    toBlock: 20000n,
    blockSpan: 1000,
    pageSize: 10,
    checkedCandidates: 2,
    nonAuctionCount: 1,
    duplicateCount: 0,
    older: null,
    newer: null,
    listings: [
      {
        listingId: "7",
        seller: market,
        requestId: hash(3),
        blockNumber: 19900n,
        blockHash: hash(19900),
        transactionHash: hash(5),
        logIndex: 2,
        state: "settled",
        asset: market,
        payment: market,
        amountRemaining: "0",
        openingBid: "900719925474099312345",
        startsAt: 100,
        endsAt: 200,
      },
    ],
  };
}
const render = () =>
  renderToStaticMarkup(
    createElement(AuctionDiscoveryBrowser, { market, onInspect: vi.fn() }),
  );
describe("public auction-discovery display", () => {
  beforeEach(() => {
    harness.reads.mockReset();
    harness.snapshot = {
      phase: "idle",
      page: null,
      pending: false,
      observedAt: null,
      failure: null,
    };
  });
  it("offers explicit source and seller navigation without an initial RPC or wallet request", () => {
    const html = render();
    expect(html).toContain("Public listing seller (optional)");
    expect(html).toContain("Older listing records");
    expect(html).toContain("Discovery does not connect or sign with a wallet");
    expect(html).not.toContain("No creation records were returned");
    expect(harness.reads).not.toHaveBeenCalled();
  });
  it("attributes exact public values and separates candidate exclusions from verified auctions", () => {
    harness.snapshot = {
      phase: "ready",
      page: page(),
      pending: false,
      observedAt: 1000,
      failure: null,
    };
    const html = render();
    expect(html).toContain("19001–20000");
    expect(html).toContain("900719925474099312345");
    expect(html).toContain("1 non-auction records were excluded");
    expect(html).toContain("Open current auction 7");
    expect(html).toContain("Contract state at snapshot");
    expect(html).toContain("Order within this page");
    expect(html).toContain("Earliest end at snapshot first");
    expect(html).toContain("Other pages are separate results");
    expect((html.match(/<li>/g) ?? []).length).toBe(1);
  });
  it.each(["unavailable", "paused", "loading"] as const)(
    "hides stale public rows while %s",
    (phase) => {
      harness.snapshot = {
        phase,
        page: page(),
        pending: phase === "loading",
        observedAt: null,
        failure: phase === "unavailable" ? "SOURCE_CHANGED" : null,
      };
      const html = render();
      expect(html).not.toContain("Open current auction 7");
      expect(html).not.toContain("Covered blocks");
      expect(html).not.toContain("No creation records were returned");
    },
  );
  it("does not turn an empty source window into global auction absence", () => {
    harness.snapshot = {
      phase: "ready",
      page: {
        ...page(),
        listings: [],
        checkedCandidates: 0,
        nonAuctionCount: 0,
      },
      pending: false,
      observedAt: 1000,
      failure: null,
    };
    expect(render()).toContain("This does not describe other blocks");
  });
});
