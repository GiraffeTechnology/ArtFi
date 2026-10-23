import "server-only";
import { isDeepStrictEqual } from "node:util";

import {
  createReceiptLedger,
  observeFundedTrade,
  observeRegistrationRequest,
  observeRegistration,
  observeSellerPayment,
  observeRegistrationRejection,
  observeReceiptRollback,
  observeBuyerRefund,
  eligibleSellerPayments,
  receiptRecoveryPlan,
  type ReceiptBinding,
  type ReceiptEvidence,
  type ReceiptSegment,
} from "./whole-receipt-ledger";
import { rwaAssetIdentity, type RwaAsset } from "./rwa-catalog";
import {
  registrarReferenceSchema,
  receiptStatusResponseSchema,
  type ReceiptStatusResponse,
} from "./whole-receipt-status";

export type VerifiedReceiptEvent =
  | { kind: "funded"; trade: Parameters<typeof observeFundedTrade>[1] }
  | { kind: "requested"; segmentId: string; evidence: ReceiptEvidence }
  | {
      kind: "registered";
      segmentId: string;
      holder: string;
      requestReference: string;
      evidence: ReceiptEvidence;
    }
  | {
      kind: "rejected";
      segmentId: string;
      requestReference: string;
      evidence: ReceiptEvidence;
    }
  | { kind: "paid"; segmentId: string; reference: string }
  | { kind: "refunded"; segmentId: string; reference: string }
  | { kind: "rolled-back"; owner: string; reference: string };

/**
 * Server-side adapter contract, not an HTTP format accepted from users.
 * An implementation must authenticate the explicitly configured Oracle data
 * source, including asset/request/record correspondence, and verify canonical
 * chain events, exact escrow funding/payment amounts, counterparties, token,
 * wallet authorization and full asset binding before returning these observations.
 * Events must be complete and causally ordered, with stable event-level references.
 * Request acceptance, pending transactions and indexer guesses are not verified events.
 */
export interface WholeReceiptReadAdapter {
  readonly intermediaryId: string;
  readonly registrarId: string;
  readonly oracleId: string;
  /** Advisory opt-in only. A corresponding-record baseline is not implemented. */
  readonly holderComparisonRequested?: boolean;
  readVerified(input: {
    asset: RwaAsset;
    viewer: string;
    signal: AbortSignal;
  }): Promise<{
    complete: true;
    binding: ReceiptBinding;
    initialHolder: string;
    observedOwner: string;
    observedAt: string;
    sourceReference: string;
    events: readonly VerifiedReceiptEvent[];
  }>;
  /** Optional direct registry lookup. Must never be embedded as a readVerified prerequisite. */
  readRegistrarReference?(input: {
    asset: RwaAsset;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export function receiptAssetKey(asset: RwaAsset): string {
  return `${asset.binding.chainId}:${asset.binding.collectionAddress.toLowerCase()}:${asset.binding.tokenId}`;
}

function ownSegment(segment: ReceiptSegment, viewer: string): boolean {
  return segment.seller === viewer || segment.buyer === viewer;
}

type RegistrarReference = Extract<
  ReceiptStatusResponse,
  { ok: true }
>["registrarReference"];

/** Bound even adapters that ignore abort; retire their signal after every outcome. */
async function boundedRead<T>(
  signal: AbortSignal,
  timeoutMs: number,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("Receipt read cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new Error("Receipt read cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Receipt read timed out"));
      }, timeoutMs);
    });
    return await Promise.race([cancelled, read(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Advisory failures are isolated; an unresponsive reference cannot hold the trusted read open. */
async function readRegistrarReference(
  adapter: WholeReceiptReadAdapter,
  asset: RwaAsset,
  signal: AbortSignal,
): Promise<RegistrarReference> {
  if (!adapter.readRegistrarReference) return { status: "not-read" };
  try {
    const lookup = adapter.readRegistrarReference.bind(adapter);
    const value = await boundedRead(signal, 2000, signal => lookup({ asset, signal }));
    const parsed = registrarReferenceSchema.safeParse(value);
    return parsed.success &&
      parsed.data.assetId === receiptAssetKey(asset) &&
      parsed.data.sourceId === adapter.registrarId
      ? { status: "available", value: parsed.data }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Read-only integration: reconstruct before exposing only this wallet's trades. */
export async function readWholeReceiptStatus(input: {
  asset: RwaAsset;
  viewer: string;
  viewerChainId: number;
  signal: AbortSignal;
  adapter?: WholeReceiptReadAdapter;
}): Promise<ReceiptStatusResponse> {
  if (input.asset.section !== "whole")
    return { ok: false, code: "WRONG_SECTION" };
  if (input.viewerChainId !== input.asset.binding.chainId) {
    return { ok: false, code: "WRONG_CHAIN" };
  }
  if (!input.adapter)
    return { ok: false, code: "SEGMENT_EVIDENCE_NOT_CONFIGURED" };
  // Preserve the existing pre-cancelled request response without starting I/O.
  if (input.signal.aborted) return { ok: false, code: "SOURCE_INVALID" };
  let snapshot;
  try {
    const source = input.adapter;
    // Match the existing Oracle transport's four-second read budget. This is
    // availability handling, never an alternative evidence or payment policy.
    snapshot = await boundedRead(input.signal, 4000, signal => source.readVerified({
      asset: input.asset,
      viewer: input.viewer,
      signal,
    }));
  } catch {
    return { ok: false, code: "SOURCE_UNAVAILABLE" };
  }
  try {
    const expected = input.asset.binding;
    if (
      input.signal.aborted ||
      snapshot.complete !== true ||
      snapshot.binding.assetId !== receiptAssetKey(input.asset) ||
      snapshot.binding.intermediaryId !== input.adapter.intermediaryId ||
      snapshot.binding.registrarId !== input.adapter.registrarId ||
      snapshot.binding.oracleId !== input.adapter.oracleId ||
      snapshot.binding.chainId !== expected.chainId ||
      snapshot.binding.collection.toLowerCase() !==
        expected.collectionAddress.toLowerCase() ||
      snapshot.binding.tokenId !== expected.tokenId
    ) {
      throw new Error("Receipt snapshot binding mismatch");
    }
    let ledger = createReceiptLedger(snapshot.binding, snapshot.initialHolder);
    const unprocessedHistorical = new Set<string>();
    const processed: VerifiedReceiptEvent[] = [];
    for (const event of snapshot.events) {
      // Authenticated journals may replay observations after reconnect. Only an
      // exact already-processed event is a no-op; reference collisions with any
      // changed field still reach the ledger's conflict checks. This grants no
      // trust to unverified input and does not perform a second financial action.
      if (processed.some((prior) => isDeepStrictEqual(prior, event))) continue;
      switch (event.kind) {
        case "funded":
          ledger = observeFundedTrade(ledger, event.trade);
          break;
        case "requested":
          ledger = observeRegistrationRequest(
            ledger,
            event.segmentId,
            event.evidence,
          );
          break;
        case "registered": {
          const confirmed = ledger.segments.find(
            (segment) =>
              segment.id === event.segmentId && segment.registrationReference,
          );
          if (confirmed) {
            // Authenticate the source/asset even when a historical response cannot be mapped.
            if (
              event.evidence.assetId !== ledger.binding.assetId ||
              event.evidence.sourceId !== ledger.binding.oracleId ||
              !event.evidence.reference.trim()
            )
              throw new Error("Historical source mismatch");
            if (
              confirmed.registrationRequest !== event.requestReference ||
              confirmed.registrationReference !== event.evidence.reference ||
              confirmed.buyer !== event.holder.toLowerCase()
            ) {
              // Do not invent record mapping, overwrite history or discard other valid segments.
              unprocessedHistorical.add(event.segmentId);
              break;
            }
          }
          ledger = observeRegistration(
            ledger,
            event.segmentId,
            event.holder,
            event.requestReference,
            event.evidence,
          );
          break;
        }
        case "rejected":
          ledger = observeRegistrationRejection(
            ledger,
            event.segmentId,
            event.requestReference,
            event.evidence,
          );
          break;
        case "paid":
          ledger = observeSellerPayment(
            ledger,
            event.segmentId,
            event.reference,
          );
          break;
        case "refunded":
          ledger = observeBuyerRefund(ledger, event.segmentId, event.reference);
          break;
        case "rolled-back":
          ledger = observeReceiptRollback(ledger, event.owner, event.reference);
          break;
        default:
          throw new Error("Unknown receipt event");
      }
      processed.push(event);
    }
    if (ledger.owner !== snapshot.observedOwner.toLowerCase()) {
      throw new Error("Receipt events and chain owner observation diverge");
    }
    const viewer = input.viewer.toLowerCase();
    const eligible = new Set(
      eligibleSellerPayments(ledger).map((segment) => segment.id),
    );
    const visibleSegments = ledger.segments.filter((segment) =>
      ownSegment(segment, viewer),
    );
    const recovery = receiptRecoveryPlan(ledger);
    const visibleRecovery =
      recovery.kind === "registered-payment-unresolved"
        ? visibleSegments.some((segment) => eligible.has(segment.id))
          ? recovery.kind
          : "none"
        : recovery.kind === "suffix-recovery" &&
            visibleSegments.some((segment) => !segment.registrationReference)
          ? recovery.kind
          : "none";
    const registrarReference = await readRegistrarReference(
      input.adapter,
      input.asset,
      input.signal,
    );
    if (input.signal.aborted) return { ok: false, code: "SOURCE_UNAVAILABLE" };
    return receiptStatusResponseSchema.parse({
      ok: true,
      assetIdentity: rwaAssetIdentity(input.asset),
      viewer,
      observedAt: snapshot.observedAt,
      sourceReference: snapshot.sourceReference,
      registrarId: ledger.binding.registrarId,
      intermediaryId: ledger.binding.intermediaryId,
      oracleId: ledger.binding.oracleId,
      owner: ledger.owner,
      registeredHolder: ledger.registeredHolder,
      registrarReference,
      // Current holder may already be D when a valid historical receipt confirms C.
      // Opt-in verification needs the corresponding record; latest-state equality is invalid.
      holderComparison: input.adapter.holderComparisonRequested
        ? "unavailable-record-baseline"
        : "not-requested",
      recovery: visibleRecovery,
      // A direct registry reference is not the trusted current identity proof required for redemption.
      redemptionIdentityMatches: null,
      segments: visibleSegments.map((segment) => ({
        id: segment.id,
        seller: segment.seller,
        buyer: segment.buyer,
        paymentToken: segment.paymentToken,
        amount: segment.amount.toString(),
        registration: segment.registrationReference
          ? "registered"
          : ledger.rejection
            ? "rejected-suffix"
            : segment.registrationRequest
              ? "requested"
              : "awaiting-request",
        payment: segment.settlementReference
          ? "seller-paid"
          : segment.refundReference
            ? "buyer-refunded"
            : "escrowed",
        paymentEligible: eligible.has(segment.id),
        historicalConfirmation: unprocessedHistorical.has(segment.id)
          ? "unprocessed"
          : "none",
      })),
    });
  } catch {
    return { ok: false, code: "SOURCE_INVALID" };
  }
}
