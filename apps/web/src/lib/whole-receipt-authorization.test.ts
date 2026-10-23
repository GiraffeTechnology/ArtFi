import { describe, expect, it } from "vitest";
import { hashTypedData, type Hex } from "viem";
import { receiptAuthorizationHash, receiptAuthorizationTypedData, type ReceiptCorrespondence } from "./whole-receipt-authorization";
import { saleIntentTypedData, type SaleIntent } from "./whole-artwork-intent";
const field = (character: string) => `0x${character.repeat(64)}` as Hex;
function fixture() {
  const sale: SaleIntent = { seller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", buyer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", collection: "0x1111111111111111111111111111111111111111", tokenId: 7n, paymentToken: "0x2222222222222222222222222222222222222222", price: 100n, salt: 1n, epoch: 0n, startsAt: 1000, endsAt: 2000 };
  const domain = { chainId: 560048, verifyingContract: "0x3333333333333333333333333333333333333333" as const };
  const correspondence: ReceiptCorrespondence = { settlementId: field("1"), assetRecordHash: field("2"), oracleSourceId: field("3"), requestHash: field("4"), executionReferenceHash: field("5"), previousSegment: field("0"), oldCertificateHash: field("6"), warehouseReceiptHash: field("7") };
  return { sale, domain, correspondence };
}
describe("whole receipt explicit asynchronous authorization", () => {
  it("pins the Solidity interoperability vector", () => {
    const {sale,domain,correspondence}=fixture();
    expect(receiptAuthorizationHash(sale,domain,correspondence)).toBe("0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9");
  });
  it("cannot reuse an atomic-sale digest and preserves all original sale terms", () => {
    const {sale,domain,correspondence}=fixture();
    const data=receiptAuthorizationTypedData(sale,domain,correspondence);
    expect(data.primaryType).toBe("ReceiptAuthorization");
    expect(receiptAuthorizationHash(sale,domain,correspondence)).not.toBe(hashTypedData(saleIntentTypedData(sale,domain)));
    expect(receiptAuthorizationHash(sale,domain,correspondence)).toBe(hashTypedData(data));
    for(const key of ["price","tokenId","salt","epoch"] as const) expect(receiptAuthorizationHash({...sale,[key]:sale[key]+1n},domain,correspondence)).not.toBe(hashTypedData(data));
  });
  it("binds each correspondence field, chain, and verifying contract", () => {
    const {sale,domain,correspondence}=fixture();
    const expected=receiptAuthorizationHash(sale,domain,correspondence);
    for(const key of Object.keys(correspondence)) expect(receiptAuthorizationHash(sale,domain,{...correspondence,[key]:field("f")})).not.toBe(expected);
    expect(receiptAuthorizationHash(sale,{...domain,chainId:31337},correspondence)).not.toBe(expected);
    expect(receiptAuthorizationHash(sale,{...domain,verifyingContract:"0x4444444444444444444444444444444444444444"},correspondence)).not.toBe(expected);
  });
  it("refuses missing, extra, malformed and zero correspondence fields", () => {
    const {sale,domain,correspondence}=fixture();
    const {requestHash,...missing}=correspondence;
    expect(requestHash).toBe(field("4"));
    for(const bad of [missing,{...correspondence,extra:field("8")},{...correspondence,requestHash:field("0")},{...correspondence,settlementId:"naked-id"}]) {
      expect(()=>receiptAuthorizationTypedData(sale,domain,bad as ReceiptCorrespondence)).toThrow("RECEIPT_CORRESPONDENCE_INVALID");
    }
  });
  it("requires named buyer, test chain, exact uint widths and nonzero deployment", () => {
    const {sale,domain,correspondence}=fixture();
    for(const bad of [{...sale,buyer:"0x0000000000000000000000000000000000000000" as const},{...sale,price:1n<<256n},{...sale,epoch:-1n},{...sale,endsAt:2**48}]) expect(()=>receiptAuthorizationTypedData(bad,domain,correspondence)).toThrow("RECEIPT_AUTHORIZATION_TERMS_INVALID");
    expect(()=>receiptAuthorizationTypedData(sale,{...domain,chainId:1},correspondence)).toThrow();
    expect(()=>receiptAuthorizationTypedData(sale,{...domain,verifyingContract:"0x0000000000000000000000000000000000000000"},correspondence)).toThrow();
  });
});
