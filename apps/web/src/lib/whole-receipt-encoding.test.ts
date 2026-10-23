import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { receiptOracleCommitments } from "./whole-receipt-oracle-binding";
const binding = {
  settlementId: "TEST_ONLY_NO_REAL_VALUE-settlement",
  assetId: "TEST_ONLY_NO_REAL_VALUE-artwork",
  token: { chainId: "560048", contract: `0x${"1".repeat(40)}`, tokenId: "7" },
  sellerWallet: `0x${"a".repeat(40)}`, buyerWallet: `0x${"b".repeat(40)}`,
  externalExecutionRef: "TEST_ONLY_NO_REAL_VALUE-operation",
  oldCertificateHash: "1".repeat(64), warehouseReceiptHash: "2".repeat(64), snapshotHash: "3".repeat(64),
};
for (const malformed of ["\ud800", "\udc00"]) {
  for (const key of ["settlementId", "assetId", "externalExecutionRef"] as const) {
    it(`rejects unpaired surrogate ${malformed.charCodeAt(0)} in ${key}`, () => {
      expect(() => receiptOracleCommitments({ ...binding, [key]: `TEST_ONLY-${malformed}` }, "TEST_ONLY-Oracle")).toThrow("RECEIPT_ORACLE_TEXT_INVALID");
    });
  }
  it(`rejects unpaired surrogate ${malformed.charCodeAt(0)} in source`, () => {
    expect(() => receiptOracleCommitments(binding, `TEST_ONLY-${malformed}`)).toThrow("RECEIPT_ORACLE_TEXT_INVALID");
  });
}
it("preserves valid supplementary Unicode and does not normalize distinct forms", () => {
  expect(() => receiptOracleCommitments({ ...binding, assetId: "TEST_ONLY-画🖼" }, "TEST_ONLY-Oracle")).not.toThrow();
  expect(receiptOracleCommitments({ ...binding, assetId: "TEST_ONLY-é" }, "TEST_ONLY-Oracle").assetRecordHash).not.toBe(receiptOracleCommitments({ ...binding, assetId: "TEST_ONLY-e\u0301" }, "TEST_ONLY-Oracle").assetRecordHash);
});
