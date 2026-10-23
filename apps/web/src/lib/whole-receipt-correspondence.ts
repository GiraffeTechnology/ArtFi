import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { oracleCertificateSchema } from "./oracle-read-model";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().min(1).max(256);
const timestamp = z.string().datetime();
const token = z
  .object({
    chainId: z.string().min(1).max(64),
    contract: z.string().min(1).max(128),
    tokenId: z.string().min(1).max(128),
  })
  .strict();
const common = {
  settlementId: z.string().min(1).max(128),
  assetId: z.string().min(1).max(128),
  token,
  snapshotHash: hash,
  oldCertificateHash: hash,
  warehouseReceiptHash: hash,
  deadlineAt: timestamp,
  businessCalendarRef: bounded,
  targetBusinessDays: z.number().int().positive().safe(),
  startedAt: timestamp,
};
export const receiptSettlementSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("PENDING") }).strict(),
  z
    .object({
      ...common,
      status: z.literal("FINALIZED"),
      registryChangeRef: bounded,
      newCertificateHash: hash,
      finalizedAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal("CANCELLED"),
      failureReasonHash: hash,
      cancelledAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal("DISPUTED"),
      failureReasonHash: hash,
      disputedAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal("TIMED_OUT"),
      failureReasonHash: hash,
      timedOutAt: timestamp,
    })
    .strict(),
]);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((x) => !/^0x0{40}$/.test(x));
export const receiptJournalBindingSchema = z
  .object({
    settlementId: z.string().min(1).max(128),
    assetId: z.string().min(1).max(128),
    token,
    // Preserve exact spellings recorded at begin: Oracle hashes strings, not addresses.
    sellerWallet: address,
    buyerWallet: address,
    externalExecutionRef: bounded,
    oldCertificateHash: hash,
    warehouseReceiptHash: hash,
    snapshotHash: hash,
  })
  .strict()
  .refine((x) => x.sellerWallet.toLowerCase() !== x.buyerWallet.toLowerCase());

/** Oracle 014cf716 canonical-json.js compatibility; NOT the journal's Go wire digest. */
function oracleDigest(value: unknown): string {
  function canonical(x: unknown): string {
    if (x === null || typeof x === "string" || typeof x === "boolean")
      return JSON.stringify(x);
    if (typeof x === "number" && Number.isSafeInteger(x))
      return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
    if (x && Object.getPrototypeOf(x) === Object.prototype)
      return `{${Object.keys(x)
        .sort()
        .map(
          (k) =>
            `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
    throw Error("SETTLEMENT_CANONICAL_VALUE_INVALID");
  }
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

/**
 * Bind the EXISTING public SettlementCoordinator projection to private journal
 * participants without exposing them or adding an Oracle transport. Call only
 * after the existing journal capability and Oracle source authentication gates.
 * This verifies correspondence, not signature authenticity, escrow, payment,
 * transfer, refund, rollback or redemption. It is not an HTTP input validator.
 * The returned result intentionally grants no financial execution permission.
 */
export function matchWholeReceiptSettlement(input: {
  journalBinding: unknown;
  settlement: unknown;
  certificate?: unknown;
}) {
  const journal = receiptJournalBindingSchema.parse(input.journalBinding);
  const settlement = receiptSettlementSchema.parse(input.settlement);
  for (const key of [
    "settlementId",
    "assetId",
    "oldCertificateHash",
    "warehouseReceiptHash",
    "snapshotHash",
  ] as const) {
    if (journal[key] !== settlement[key])
      throw Error("SETTLEMENT_JOURNAL_BINDING_MISMATCH");
  }
  for (const key of ["chainId", "contract", "tokenId"] as const) {
    if (journal.token[key] !== settlement.token[key])
      throw Error("SETTLEMENT_TOKEN_BINDING_MISMATCH");
  }
  const computed = oracleDigest({
    schemaVersion: "giraffe-settlement-snapshot.v1",
    settlementId: journal.settlementId,
    assetId: journal.assetId,
    token: journal.token,
    sellerWallet: journal.sellerWallet,
    buyerWallet: journal.buyerWallet,
    externalExecutionRef: journal.externalExecutionRef,
    oldCertificateHash: journal.oldCertificateHash,
    warehouseReceiptHash: journal.warehouseReceiptHash,
    deadlineAt: settlement.deadlineAt,
    businessCalendarRef: settlement.businessCalendarRef,
    targetBusinessDays: settlement.targetBusinessDays,
    observedAt: settlement.startedAt,
  });
  if (computed !== settlement.snapshotHash)
    throw Error("SETTLEMENT_PRIVATE_CORRESPONDENCE_MISMATCH");
  if (Date.parse(settlement.deadlineAt) <= Date.parse(settlement.startedAt))
    throw Error("SETTLEMENT_TIME_INVALID");
  if (settlement.status !== "FINALIZED") {
    return {
      status: settlement.status,
      settlementId: settlement.settlementId,
      snapshotHash: computed,
      registrationConfirmed: false as const,
      financialExecutionAuthorized: false as const,
    };
  }
  const certificate = oracleCertificateSchema.parse(input.certificate);
  if (
    certificate.assetId !== journal.assetId ||
    certificate.tokenId !== journal.token.tokenId ||
    certificate.certificateHash !== settlement.newCertificateHash ||
    certificate.previousCertificateHash !== journal.oldCertificateHash ||
    certificate.warehouseReceiptHash !== journal.warehouseReceiptHash ||
    certificate.wenbaoChangeRef !== settlement.registryChangeRef ||
    certificate.settlementId !== journal.settlementId ||
    certificate.settlementSnapshotHash !== computed ||
    certificate.status === "REVOKED"
  ) {
    throw Error("SETTLEMENT_CERTIFICATE_CORRESPONDENCE_MISMATCH");
  }
  if (
    Date.parse(settlement.finalizedAt) < Date.parse(settlement.startedAt) ||
    Date.parse(settlement.finalizedAt) > Date.parse(settlement.deadlineAt)
  )
    throw Error("SETTLEMENT_TIME_INVALID");
  // SUPERSEDED is valid historical evidence. Current holder/asset status is not
  // consulted: a later D must not erase the authenticated earlier C segment.
  return {
    status: settlement.status,
    settlementId: settlement.settlementId,
    snapshotHash: computed,
    registrationConfirmed: true as const,
    registryChangeRef: settlement.registryChangeRef,
    certificateHash: certificate.certificateHash,
    financialExecutionAuthorized: false as const,
  };
}
