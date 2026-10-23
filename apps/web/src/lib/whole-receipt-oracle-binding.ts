import "server-only";
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { receiptJournalBindingSchema } from "./whole-receipt-correspondence";
import type { ReceiptCorrespondence } from "./whole-receipt-authorization";

/** ArtFi preimage encoding for new asynchronous authorizations, not an Oracle
 * protocol change or a migration of existing records. Text is hashed as exact
 * UTF-8, without case folding or Unicode normalization. Oracle's already-hashed
 * snapshot/certificate values are decoded as bytes32, never hashed a second time.
 * The caller must retain the actual approved preimages; none are inferred here.
 */
export function receiptOracleCommitments(raw: unknown, sourceId: string) {
  const binding = receiptJournalBindingSchema.parse(raw);
  if (!sourceId.trim() || sourceId.length > 256)
    throw Error("RECEIPT_ORACLE_SOURCE_INVALID");
  const digest = (value: string): Hex => {
    const bytes = Buffer.from(value, "utf8");
    // Reject replacement of unpaired UTF-16 surrogates: distinct preimages must
    // not silently become the same UTF-8 byte sequence before signing.
    if (bytes.toString("utf8") !== value)
      throw Error("RECEIPT_ORACLE_TEXT_INVALID");
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
  };
  return {
    settlementId: digest(binding.settlementId),
    assetRecordHash: digest(binding.assetId),
    oracleSourceId: digest(sourceId),
    requestHash: `0x${binding.snapshotHash}` as Hex,
    executionReferenceHash: digest(binding.externalExecutionRef),
    oldCertificateHash: `0x${binding.oldCertificateHash}` as Hex,
    warehouseReceiptHash: `0x${binding.warehouseReceiptHash}` as Hex,
  } satisfies Omit<ReceiptCorrespondence, "previousSegment">;
}

export function assertReceiptOracleBinding(
  raw: unknown,
  sourceId: string,
  sale: { seller: string; buyer: string; collection: string; tokenId: bigint },
  chainId: number,
  signed: ReceiptCorrespondence,
) {
  const binding = receiptJournalBindingSchema.parse(raw);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const commitments = receiptOracleCommitments(binding, sourceId);
  if (
    binding.token.chainId !== String(chainId) ||
    !same(binding.token.contract, sale.collection) ||
    binding.token.tokenId !== String(sale.tokenId) ||
    !same(binding.sellerWallet, sale.seller) ||
    !same(binding.buyerWallet, sale.buyer) ||
    (Object.keys(commitments) as (keyof typeof commitments)[]).some(
      (key) => !same(commitments[key], signed[key]),
    )
  )
    throw Error("RECEIPT_ORACLE_SIGNED_BINDING_MISMATCH");
  return binding;
}
