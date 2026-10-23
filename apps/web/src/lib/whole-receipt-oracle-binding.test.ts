import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertReceiptOracleBinding, receiptOracleCommitments } from "./whole-receipt-oracle-binding";
const binding = {
  settlementId: "abc", assetId: "TEST_ONLY_NO_REAL_VALUE-asset",
  token: {chainId:"560048",contract:`0x${"1".repeat(40)}`,tokenId:"7"},
  sellerWallet:`0x${"a".repeat(40)}`,buyerWallet:`0x${"b".repeat(40)}`,
  externalExecutionRef:"TEST_ONLY_NO_REAL_VALUE-operation",
  oldCertificateHash:"1".repeat(64),warehouseReceiptHash:"2".repeat(64),snapshotHash:"3".repeat(64),
};
const source="TEST_ONLY_NO_REAL_VALUE-Oracle";
const sale={seller:binding.sellerWallet,buyer:binding.buyerWallet,collection:binding.token.contract,tokenId:7n};
const signed={...receiptOracleCommitments(binding,source),previousSegment:`0x${"0".repeat(64)}` as const};
describe("journal-to-Oracle exact preimage commitments",()=>{
  it("uses exact UTF-8 SHA256 and does not double hash Oracle hashes",()=>{
    expect(signed.settlementId).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(signed.requestHash).toBe(`0x${binding.snapshotHash}`);
    expect(assertReceiptOracleBinding(binding,source,sale,560048,signed)).toEqual(binding);
  });
  for(const key of ["settlementId","assetId","externalExecutionRef","snapshotHash","oldCertificateHash","warehouseReceiptHash","sellerWallet","buyerWallet"] as const){
    it(`rejects substituted ${key}`,()=>{
      const changed={...binding,[key]:key.endsWith("Hash")?"4".repeat(64):key.endsWith("Wallet")?`0x${"c".repeat(40)}`:"TEST_ONLY_CHANGED"};
      expect(()=>assertReceiptOracleBinding(changed,source,sale,560048,signed)).toThrow();
    });
  }
  it("rejects a different source, chain, collection or token",()=>{
    expect(()=>assertReceiptOracleBinding(binding,source+"-other",sale,560048,signed)).toThrow();
    expect(()=>assertReceiptOracleBinding(binding,source,sale,31337,signed)).toThrow();
    expect(()=>assertReceiptOracleBinding(binding,source,{...sale,tokenId:8n},560048,signed)).toThrow();
    expect(()=>assertReceiptOracleBinding(binding,source,{...sale,collection:`0x${"2".repeat(40)}`},560048,signed)).toThrow();
  });
  it("does not normalize text preimages or accept an empty source",()=>{
    expect(receiptOracleCommitments({...binding,assetId:binding.assetId.toUpperCase()},source).assetRecordHash).not.toBe(signed.assetRecordHash);
    expect(()=>receiptOracleCommitments(binding," ")).toThrow();
  });
});
