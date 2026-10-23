import { hashStruct, hashTypedData, isAddress, type Hex } from "viem";
import { saleIntentTypes, validateSaleIntent, type SaleIntent, type SaleIntentDomain } from "./whole-artwork-intent";

/** Explicit asynchronous consent; existing atomic-sale signatures are incompatible. */
export const receiptAuthorizationDomain = { name: "ArtFi Whole Artwork Receipt Settlement", version: "1" } as const;
export const receiptAuthorizationTypes = {
  ReceiptAuthorization: [
    { name: "saleIntentHash", type: "bytes32" },
    { name: "settlementId", type: "bytes32" },
    { name: "assetRecordHash", type: "bytes32" },
    { name: "oracleSourceId", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "executionReferenceHash", type: "bytes32" },
    { name: "previousSegment", type: "bytes32" },
    { name: "oldCertificateHash", type: "bytes32" },
    { name: "warehouseReceiptHash", type: "bytes32" },
  ],
} as const;

export type ReceiptCorrespondence = {
  settlementId: Hex; assetRecordHash: Hex; oracleSourceId: Hex;
  requestHash: Hex; executionReferenceHash: Hex; previousSegment: Hex;
  oldCertificateHash: Hex; warehouseReceiptHash: Hex;
};

/** Builds data only. It never calls a wallet or enables a production execution path.
 * Correspondence must be supplied by the authenticated journal, not browser input.
 * A canonical finalized Oracle record and separate chain proof are still required.
 */
export function receiptAuthorizationTypedData(sale: SaleIntent, domain: SaleIntentDomain, correspondence: ReceiptCorrespondence) {
  const zero = /^0x0+$/;
  const fields = receiptAuthorizationTypes.ReceiptAuthorization.slice(1).map(field => field.name);
  const keys = Object.keys(correspondence).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...fields].sort()) ||
      fields.some(field => !/^0x[0-9a-fA-F]{64}$/.test(correspondence[field as keyof ReceiptCorrespondence]) || (field !== "previousSegment" && zero.test(correspondence[field as keyof ReceiptCorrespondence])))) {
    throw Error("RECEIPT_CORRESPONDENCE_INVALID");
  }
  if (![31337, 560048].includes(domain.chainId) || !isAddress(domain.verifyingContract) || zero.test(domain.verifyingContract) ||
      validateSaleIntent(sale, domain, domain.chainId).length || zero.test(sale.buyer) ||
      [sale.tokenId, sale.price, sale.salt, sale.epoch].some(value => value < 0n || value >= 1n << 256n)) {
    throw Error("RECEIPT_AUTHORIZATION_TERMS_INVALID");
  }
  return {
    domain: { ...receiptAuthorizationDomain, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    types: receiptAuthorizationTypes,
    primaryType: "ReceiptAuthorization" as const,
    message: { saleIntentHash: hashStruct({ data: sale, types: saleIntentTypes, primaryType: "SaleIntent" }), ...correspondence },
  };
}

export function receiptAuthorizationHash(sale: SaleIntent, domain: SaleIntentDomain, correspondence: ReceiptCorrespondence): Hex {
  return hashTypedData(receiptAuthorizationTypedData(sale, domain, correspondence));
}
