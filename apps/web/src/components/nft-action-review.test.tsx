import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NftActionReview, type NftReviewOperation } from "./nft-action-review";
const wallet = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}`;
export function operation(): NftReviewOperation {
  return {
    id: "TEST_ONLY-operation",
    status: "awaiting-wallet",
    plan: {
      id: "TEST_ONLY-plan",
      operationId: "TEST_ONLY-operation",
      sessionId: "TEST_ONLY-session",
      chainId: 1,
      request: {
        action: "list",
        collection: "test-only",
        tokenId: "7654321",
        account: wallet,
        quantity: "17",
        priceWei: "12345000000000000",
        expiresAt: 1800000000,
      },
      scope: {
        slug: "test-only",
        chain: "ethereum",
        contract: "0x2222222222222222222222222222222222222222",
        standard: "erc1155",
        label: "TEST_ONLY_PRIVATE_COLLECTION",
        charity: true,
      },
      expiresAt: 1800000000000,
      kind: "signature",
      summary: "TEST_ONLY_PRIVATE_REVIEW_SUMMARY",
      orderTotalWei: "12345000000000000",
      paymentToken: "ETH",
      fees: [
        {
          recipient: "0x3333333333333333333333333333333333333333",
          amountWei: "1200000000000000",
        },
      ],
      sourceURL: "https://opensea.io/assets/ethereum/test-only/7654321",
    },
    transactionHash: hash,
    orderHash: `0x${"cd".repeat(32)}`,
  };
}
function render(
  row = operation(),
  flags: { busy?: boolean; attempted?: boolean } = {},
) {
  const no = () => {};
  return renderToStaticMarkup(
    createElement(NftActionReview, {
      operation: row,
      busy: false,
      onConfirm: no,
      onAbandon: no,
      onDiscardUnsubmittedSignature: no,
      onCancelAccepted: no,
      onClose: no,
      ...flags,
    }),
  );
}
const publicText = (html: string) =>
  html
    .replace(/<(p|span|time)\b[^>]*data-no-translate[^>]*>[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ");
describe("NFT review localized UI and exact fact boundary", () => {
  it("admits fixed labels and controls to the existing translator without a blanket exclusion", () => {
    const html = render();
    expect(html.match(/^<section[^>]+>/)?.[0]).not.toContain(
      "data-no-translate",
    );
    const text = publicText(html);
    for (const label of [
      "Review listing",
      "Collection",
      "Contract",
      "Token",
      "Quantity",
      "Order total",
      "Wallet",
      "Chain",
      "Fee",
      "Status:",
      "Confirm in wallet",
      "Discard unsigned review",
      "Close review",
    ])
      expect(text).toContain(label);
  });
  it("keeps every authoritative value and private summary outside translation input", () => {
    const row = operation(),
      html = render(row),
      text = publicText(html);
    for (const fact of [
      wallet,
      row.plan.scope.contract,
      row.plan.scope.label,
      row.plan.summary,
      row.plan.request.tokenId,
      "0.012345",
      "0.0012",
      row.plan.fees[0].recipient,
      hash,
      row.orderHash!,
      row.plan.sourceURL!,
      "awaiting-wallet",
    ]) {
      expect(html).toContain(fact);
      expect(text).not.toContain(fact);
    }
    expect(html).toMatch(/<time data-no-translate="(?:true)?">[^<]+<\/time>/);
    expect(row).toEqual(operation());
  });
  it.each(["list", "offer", "buy", "accept", "cancel"] as const)(
    "shows a controlled translatable title for %s",
    (action) => {
      const row = operation();
      row.plan.request.action = action;
      expect(publicText(render(row))).toContain(
        action === "list"
          ? "Review listing"
          : action === "offer"
            ? "Review offer"
            : action === "buy"
              ? "Review purchase"
              : action === "accept"
                ? "Review offer acceptance"
                : "Review order cancellation",
      );
    },
  );
  it.each(["busy", "attempted", "walletStarted", "pending"])(
    "never restores confirmation when %s blocks it",
    (mode) => {
      const row = operation();
      if (mode === "walletStarted") row.walletStarted = true;
      if (mode === "pending") row.status = "pending";
      expect(
        render(row, { busy: mode === "busy", attempted: mode === "attempted" }),
      ).toMatch(/<button disabled="">Confirm in wallet<\/button>/);
    },
  );
  it("preserves recovery controls for started signatures and accepted orders", () => {
    const row = operation();
    row.walletStarted = true;
    expect(publicText(render(row))).toContain(
      "Discard unsubmitted signature review",
    );
    expect(publicText(render(row))).not.toContain("Discard unsigned review");
    row.status = "accepted";
    expect(publicText(render(row))).toContain("Cancel this order on chain");
  });
  it("preserves approval and cancellation meanings while keeping amounts exact", () => {
    const row = operation();
    row.plan.kind = "approval";
    expect(publicText(render(row))).toContain(
      "This approval does not publish an order.",
    );
    row.plan.request.action = "cancel";
    expect(publicText(render(row))).toContain(
      "Cancellation sends no purchase payment.",
    );
    expect(render(row).replace(/<!-- -->/g, "")).toContain("0.012345 ETH");
  });
});
