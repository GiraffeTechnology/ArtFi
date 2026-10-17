import "server-only";
import { z } from "zod";
import { isAddress } from "viem";
import { nftTaskJournalDigest } from "./nft/task-journal";
import {
  projectWholeReceiptApprovalBusiness,
  projectWholeReceiptBusiness,
} from "./whole-receipt-business";

/** Application content namespaces, using the existing native canonical SHA256
 * encoder. Neither content digest is a grant, signature or source authority. */
export const WHOLE_RECEIPT_BUSINESS_SCHEMA =
  "artfi-whole-receipt-business-plan/1";
export const WHOLE_RECEIPT_ASSOCIATION_SCHEMA =
  "artfi-whole-receipt-journal-binding/1";

const address = z.string()
  .refine((x) => isAddress(x) && !/^0x0{40}$/i.test(x))
  .transform((x) => x.toLowerCase());
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
  .refine((x) => !/^0x0{64}$/i.test(x))
  .transform((x) => x.toLowerCase());
const bindingSchema = z.object({
  tenant: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  origin: z.string().max(2048).refine((value) => {
    try {
      const origin = new URL(value);
      return origin.origin === value && (
        origin.protocol === "https:" ||
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      );
    } catch {
      return false;
    }
  }),
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  actor: address,
  escrow: address,
  runtimeCodeHash: hash,
}).strict();
export type WholeReceiptApprovalBinding = z.infer<typeof bindingSchema>;
const bindingKeys = [
  "tenant", "origin", "taskId", "actor", "escrow", "runtimeCodeHash",
];
const correspondenceKeys = [
  "settlementId", "assetRecordHash", "oracleSourceId", "requestHash",
  "executionReferenceHash", "previousSegment", "oldCertificateHash",
  "warehouseReceiptHash",
] as const;

function refuse(): never {
  throw Error("RECEIPT_APPROVAL_COMMITMENT_REFUSED");
}
function fields(raw: unknown, keys: readonly string[]) {
  if (
    !raw || typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    refuse();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) =>
      !Object.hasOwn(descriptors, key) ||
      !descriptors[key]!.enumerable ||
      !Object.hasOwn(descriptors[key]!, "value")
    )
  )
    refuse();
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key]!.value]),
  );
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function canonicalBusiness(rawBusiness: unknown) {
  const p = projectWholeReceiptApprovalBusiness(rawBusiness);
  const r = p.wholeReceipt;
  return {
    kind: p.kind,
    chainId: p.chainId,
    request: { account: p.request.account.toLowerCase() },
    wholeReceipt: {
      schemaVersion: r.schemaVersion,
      phase: r.phase,
      segmentId: r.segmentId.toLowerCase(),
      domain: {
        chainId: r.domain.chainId,
        verifyingContract: r.domain.verifyingContract.toLowerCase(),
      },
      sale: {
        ...r.sale,
        seller: r.sale.seller.toLowerCase(),
        collection: r.sale.collection.toLowerCase(),
        paymentToken: r.sale.paymentToken.toLowerCase(),
        buyer: r.sale.buyer.toLowerCase(),
      },
      correspondence: Object.fromEntries(
        correspondenceKeys.map((key) => [
          key, r.correspondence[key].toLowerCase(),
        ]),
      ),
      ...(r.kitRegistration ? {
        kitRegistration: {
          version: r.kitRegistration.version,
          proofHash: r.kitRegistration.proofHash.toLowerCase(),
        },
      } : {}),
    },
  };
}

/** Installation-owned metadata and validated immutable business content only.
 * Do not obtain binding fields from a browser, Oracle response or this result.
 * This supplies Wallet's existing opaque slots before the grant exists. */
export function createWholeReceiptApprovalCommitments(
  rawBusiness: unknown,
  rawBinding: unknown,
) {
  try {
    const binding = bindingSchema.parse(fields(rawBinding, bindingKeys));
    const business = canonicalBusiness(rawBusiness);
    const receipt = business.wholeReceipt;
    if (
      binding.actor !== business.request.account ||
      binding.escrow !== receipt.domain.verifyingContract
    )
      refuse();
    const receiptPlanDigest = "0x" + nftTaskJournalDigest({
      schema: WHOLE_RECEIPT_BUSINESS_SCHEMA,
      business,
    });
    const association = {
      schema: WHOLE_RECEIPT_ASSOCIATION_SCHEMA,
      tenant: binding.tenant,
      origin: binding.origin,
      taskId: binding.taskId,
      actor: binding.actor,
      phase: receipt.phase,
      escrow: binding.escrow,
      runtimeCodeHash: binding.runtimeCodeHash,
      segmentId: receipt.segmentId,
      businessDigest: receiptPlanDigest,
    };
    const receiptJournalBindingHash =
      "0x" + nftTaskJournalDigest(association);
    return freeze({
      business,
      binding,
      association,
      receiptPlanDigest,
      receiptJournalBindingHash,
      authorization: "NOT_ESTABLISHED" as const,
    });
  } catch {
    refuse();
  }
}

/** Verify content commitments after a genuine runtime has supplied the current
 * stored slots and installation binding. The native plan's complete principal
 * and operation ID are still independently validated and retained. Grant and
 * source authority are not established by content equality. No gate, journal
 * write, nonce reservation, capability or provider request is opened here. */
export function assertWholeReceiptApprovalPlan(
  rawPlan: unknown,
  rawBinding: unknown,
  rawExpected: unknown,
) {
  try {
    const projected = projectWholeReceiptBusiness(rawPlan);
    const expected = fields(rawExpected, [
      "receiptPlanDigest", "receiptJournalBindingHash",
    ]);
    const result = createWholeReceiptApprovalCommitments(
      projected.business,
      rawBinding,
    );
    if (
      projected.nativePlan.taskPrincipal.taskId !== result.binding.taskId ||
      expected.receiptPlanDigest !== result.receiptPlanDigest ||
      expected.receiptJournalBindingHash !== result.receiptJournalBindingHash
    )
      refuse();
    return freeze({ ...result, nativePlan: projected.nativePlan });
  } catch {
    refuse();
  }
}
