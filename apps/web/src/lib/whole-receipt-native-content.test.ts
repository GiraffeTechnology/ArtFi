import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertWholeReceiptApprovalPlan } from "./whole-receipt-commitments";
import { nftTaskJournalDigest } from "./nft/task-journal";
vi.mock("server-only", () => ({}));

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../api/internal/httpapi/testdata/nft_receipt_content_vectors.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  fixture: string;
  vectors: Array<{
    name: string;
    binding: unknown;
    nativePlan: unknown;
    claims: { receiptPlanDigest: string; receiptJournalBindingHash: string };
    nativePlanDigest: string;
  }>;
};

describe("synthetic native Go / application content contract", () => {
  it("retains explicit synthetic provenance and all three phase vectors", () => {
    expect(fixture.fixture).toBe("SYNTHETIC_NO_REAL_WALLET_OR_SOURCE");
    expect(fixture.vectors.map((v) => v.name)).toEqual([
      "funded",
      "registered",
      "paid",
    ]);
  });
  it.each(fixture.vectors)(
    "matches the independent canonical $name vector",
    (v) => {
      const result = assertWholeReceiptApprovalPlan(v.nativePlan, v.binding, {
        receiptPlanDigest: v.claims.receiptPlanDigest,
        receiptJournalBindingHash: v.claims.receiptJournalBindingHash,
      });
      expect(result.nativePlan).toEqual(v.nativePlan);
      expect(result.authorization).toBe("NOT_ESTABLISHED");
      expect(result.receiptPlanDigest).toBe(v.claims.receiptPlanDigest);
      expect(result.receiptJournalBindingHash).toBe(
        v.claims.receiptJournalBindingHash,
      );
      expect(nftTaskJournalDigest(v.nativePlan)).toBe(v.nativePlanDigest);
    },
  );
});
