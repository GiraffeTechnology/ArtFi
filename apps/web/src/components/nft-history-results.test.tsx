import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NftHistoryResults } from "./nft-history-results";
import type { NftOperationHistory } from "@/lib/nft/model";

const history: NftOperationHistory = {
  wallet: "0x" + "a".repeat(40),
  chainId: 1,
  page: 1,
  pageSize: 25,
  hasMore: true,
  data: [
    {
      id: "TEST_ONLY-operation-0001",
      chainId: 1,
      action: "list",
      status: "accepted",
      collection: "test-only-collection",
      tokenId: "7",
      kind: "signature",
      walletStarted: true,
      orderHash: "0x" + "1".repeat(64),
      transactionHash: "0x" + "2".repeat(64),
      updatedAt: "2026-10-15T18:00:00.123456789Z",
    },
  ],
};
describe("native NFT recorded-result panel", () => {
  it("renders complete references and page-local scope without automatically recovering or paging", () => {
    const recover = vi.fn(),
      page = vi.fn();
    const html = renderToStaticMarkup(
      createElement(NftHistoryResults, {
        history,
        busy: false,
        onRecover: recover,
        onPage: page,
      }),
    );
    expect(html).toContain(history.wallet);
    expect(html).toContain(history.data[0]!.transactionHash);
    expect(html).toContain(history.data[0]!.orderHash);
    expect(html).toContain(history.data[0]!.updatedAt);
    expect(html).toContain("Filters apply to this loaded page only");
    expect(html).toContain("does not establish settlement");
    expect(html).toContain("Recorded status on this page");
    expect(html).toContain("Recover this NFT operation");
    expect(recover).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });
  it("renders a genuinely empty page without declaring the entire history empty", () => {
    const html = renderToStaticMarkup(
      createElement(NftHistoryResults, {
        history: { ...history, data: [] },
        busy: false,
        onRecover: vi.fn(),
        onPage: vi.fn(),
      }),
    );
    expect(html).toContain(
      "No recorded NFT operation is present on this page.",
    );
    expect(html).toContain("Next NFT operations");
    expect(html).not.toContain("no NFT operation exists");
  });
  it("keeps recovery and pagination disabled while an action is busy", () => {
    const html = renderToStaticMarkup(
      createElement(NftHistoryResults, {
        history,
        busy: true,
        onRecover: vi.fn(),
        onPage: vi.fn(),
      }),
    );
    expect(html).toMatch(/disabled=""[^>]*>\s*Recover this NFT operation/);
    expect(html).toMatch(/disabled=""[^>]*>\s*Next NFT operations/);
  });
});
