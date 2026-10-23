/**
 * Whole-artwork receipt workflow projection. This module has no transaction authority.
 * Inputs must come from authenticated, identity-bound chain/Oracle adapters, never
 * directly from a browser request. Evidence references are audit references, not proofs.
 * The configured Oracle is the trusted intermediary data role. A direct registry
 * query is reference information and cannot confirm, reject or veto a trade here.
 * No production adapter, signature, escrow, forced transfer or redemption is implemented here.
 */
export type ReceiptBinding = Readonly<{
  assetId: string;
  chainId: number;
  collection: string;
  tokenId: string;
  intermediaryId: string;
  registrarId: string;
  /** Functional trusted-data source, not an inferred organization or deployment. */
  oracleId: string;
}>;

export type ReceiptSegment = Readonly<{
  id: string;
  seller: string;
  buyer: string;
  paymentToken: string;
  amount: bigint;
  escrowReference: string;
  ownerTransferReference: string;
  registrationRequest?: string;
  registrationReference?: string;
  settlementReference?: string;
  refundReference?: string;
}>;

export type ReceiptLedger = Readonly<{
  binding: ReceiptBinding;
  initialHolder: string;
  owner: string;
  registeredHolder: string;
  segments: readonly ReceiptSegment[];
  /** Number of sequential trades confirmed through the trusted Oracle source. */
  registeredPrefix: number;
  /** Number of sequential trades whose seller payment has been observed. */
  settledPrefix: number;
  rejection?: Readonly<{
    segmentId: string;
    reference: string;
    rollbackReference?: string;
  }>;
}>;

export type ReceiptEvidence = Readonly<{
  assetId: string;
  sourceId: string;
  reference: string;
}>;

const zero = /^0x0{40}$/i;
function account(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || zero.test(value)) {
    throw new Error("Invalid receipt account");
  }
  return value.toLowerCase();
}
function required(value: string): string {
  if (!value.trim()) throw new Error("Missing receipt reference");
  return value;
}

export function createReceiptLedger(
  binding: ReceiptBinding,
  initialHolder: string,
): ReceiptLedger {
  required(binding.assetId);
  required(binding.intermediaryId);
  required(binding.registrarId);
  required(binding.oracleId);
  if (binding.intermediaryId === binding.registrarId) {
    throw new Error("Intermediary and registrar source roles must be distinct");
  }
  account(binding.collection);
  if (!Number.isSafeInteger(binding.chainId) || binding.chainId <= 0 ||
      typeof binding.tokenId !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(binding.tokenId) ||
      BigInt(binding.tokenId) >= 2n ** 256n) {
    throw new Error("Invalid receipt binding");
  }
  const holder = account(initialHolder);
  return {
    binding: { ...binding }, initialHolder: holder, owner: holder,
    registeredHolder: holder, segments: [], registeredPrefix: 0, settledPrefix: 0,
  };
}

function evidence(
  ledger: ReceiptLedger,
  value: ReceiptEvidence,
  source: string,
) {
  if (value.assetId !== ledger.binding.assetId || value.sourceId !== source) {
    throw new Error("Receipt evidence binding mismatch");
  }
  required(value.reference);
}

function replace(
  ledger: ReceiptLedger,
  index: number,
  change: Partial<ReceiptSegment>,
): ReceiptLedger {
  return {
    ...ledger,
    segments: ledger.segments.map((segment, i) =>
      i === index ? { ...segment, ...change } : segment),
  };
}

/** Record a verified funded trade and its NFT transfer, not a match or wallet prompt. */
export function observeFundedTrade(
  ledger: ReceiptLedger,
  trade: Omit<ReceiptSegment, "registrationRequest" | "registrationReference" |
    "settlementReference" | "refundReference">,
): ReceiptLedger {
  if (ledger.rejection) throw new Error("Receipt chain is rejected");
  required(trade.id);
  required(trade.escrowReference);
  required(trade.ownerTransferReference);
  if (ledger.segments.some((segment) => segment.id === trade.id ||
      segment.escrowReference === trade.escrowReference ||
      segment.ownerTransferReference === trade.ownerTransferReference)) {
    throw new Error("Duplicate trade evidence");
  }
  const seller = account(trade.seller);
  const buyer = account(trade.buyer);
  if (seller !== ledger.owner || seller === buyer || typeof trade.amount !== "bigint" ||
      trade.amount <= 0n || trade.amount >= 2n ** 256n) {
    throw new Error("Invalid funded trade");
  }
  // Copy only the expected fields; runtime callers cannot inject a settled status.
  const segment: ReceiptSegment = {
    id: trade.id, seller, buyer, paymentToken: account(trade.paymentToken),
    amount: trade.amount, escrowReference: trade.escrowReference,
    ownerTransferReference: trade.ownerTransferReference,
  };
  return { ...ledger, owner: buyer, segments: [...ledger.segments, segment] };
}

/** A request acceptance is not a holder update or payment release. */
export function observeRegistrationRequest(
  ledger: ReceiptLedger,
  segmentId: string,
  receipt: ReceiptEvidence,
): ReceiptLedger {
  evidence(ledger, receipt, ledger.binding.intermediaryId);
  const segment = ledger.segments[ledger.registeredPrefix];
  if (ledger.rejection || !segment || segment.id !== segmentId ||
      segment.registrationRequest) throw new Error("Registration request out of sequence");
  return replace(ledger, ledger.registeredPrefix, { registrationRequest: receipt.reference });
}

export function observeRegistration(
  ledger: ReceiptLedger,
  segmentId: string,
  holder: string,
  requestReference: string,
  receipt: ReceiptEvidence,
): ReceiptLedger {
  evidence(ledger, receipt, ledger.binding.oracleId);
  const prior = ledger.segments.findIndex((segment) => segment.id === segmentId);
  if (prior >= 0 && prior < ledger.registeredPrefix) {
    const confirmed = ledger.segments[prior];
    if (confirmed.registrationRequest === requestReference &&
        confirmed.registrationReference === receipt.reference &&
        confirmed.buyer === account(holder)) return ledger;
    throw new Error("Historical confirmation requires reconciliation");
  }
  const segment = ledger.segments[ledger.registeredPrefix];
  if (ledger.rejection || !segment || segment.id !== segmentId ||
      !segment.registrationRequest || segment.registrationRequest !== requestReference ||
      account(holder) !== segment.buyer || segment.seller !== ledger.registeredHolder) {
    throw new Error("Oracle confirmation out of sequence");
  }
  return {
    ...replace(ledger, ledger.registeredPrefix, { registrationReference: receipt.reference }),
    registeredHolder: segment.buyer, registeredPrefix: ledger.registeredPrefix + 1,
  };
}

/** Eligibility is per trade. Later trades and global finality are not release gates. */
export function eligibleSellerPayments(ledger: ReceiptLedger): readonly ReceiptSegment[] {
  return ledger.segments.slice(0, ledger.registeredPrefix)
    .filter((segment) => !segment.settlementReference);
}

/** Oldest eligible payment for display; this is not an execution-order requirement. */
export function nextSellerPayment(ledger: ReceiptLedger): ReceiptSegment | undefined {
  return eligibleSellerPayments(ledger)[0];
}

/** Adapter must verify exact token, amount, seller and canonical transaction outcome. */
export function observeSellerPayment(
  ledger: ReceiptLedger,
  segmentId: string,
  reference: string,
): ReceiptLedger {
  required(reference);
  const index = ledger.segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0 || index >= ledger.registeredPrefix ||
      ledger.segments[index].settlementReference) throw new Error("Seller payment is not eligible");
  if (ledger.segments.some((item) => item.settlementReference === reference)) {
    throw new Error("Duplicate seller payment evidence");
  }
  const observed = replace(ledger, index, { settlementReference: reference });
  let settledPrefix = ledger.settledPrefix;
  while (settledPrefix < observed.registeredPrefix &&
      observed.segments[settledPrefix].settlementReference) settledPrefix += 1;
  return { ...observed, settledPrefix };
}

export function observeRegistrationRejection(
  ledger: ReceiptLedger,
  segmentId: string,
  requestReference: string,
  receipt: ReceiptEvidence,
): ReceiptLedger {
  evidence(ledger, receipt, ledger.binding.oracleId);
  const segment = ledger.segments[ledger.registeredPrefix];
  if (ledger.rejection || !segment || segment.id !== segmentId ||
      !segment.registrationRequest || segment.registrationRequest !== requestReference) {
    throw new Error("Oracle rejection out of sequence");
  }
  return { ...ledger, rejection: { segmentId, reference: receipt.reference } };
}

export function receiptRecoveryPlan(ledger: ReceiptLedger) {
  if (!ledger.rejection) return { kind: "none" as const };
  // A registered-but-unpaid segment is not silently put into the refund suffix.
  // Its disposition remains a product decision; this projection cannot spend funds.
  if (ledger.registeredPrefix !== ledger.settledPrefix) {
    return { kind: "registered-payment-unresolved" as const };
  }
  return {
    kind: "suffix-recovery" as const,
    returnTokenTo: ledger.registeredHolder,
    rollbackObserved: Boolean(ledger.rejection.rollbackReference),
    segments: ledger.segments.slice(ledger.registeredPrefix).map((segment) => ({
      segmentId: segment.id, refundTo: segment.buyer,
      paymentToken: segment.paymentToken, amount: segment.amount,
      refundGasPayer: segment.buyer, rollbackGasPayer: segment.buyer,
      refunded: Boolean(segment.refundReference),
    })),
  };
}

/** Records an externally authorized rollback; never grants ArtFi forced-transfer power. */
export function observeReceiptRollback(
  ledger: ReceiptLedger,
  owner: string,
  reference: string,
): ReceiptLedger {
  required(reference);
  const plan = receiptRecoveryPlan(ledger);
  if (!ledger.rejection || plan.kind !== "suffix-recovery" || plan.rollbackObserved ||
      account(owner) !== plan.returnTokenTo) throw new Error("Invalid receipt rollback");
  return {
    ...ledger, owner: account(owner),
    rejection: { ...ledger.rejection, rollbackReference: reference },
  };
}

export function observeBuyerRefund(
  ledger: ReceiptLedger,
  segmentId: string,
  reference: string,
): ReceiptLedger {
  required(reference);
  const plan = receiptRecoveryPlan(ledger);
  const index = ledger.segments.findIndex((segment) => segment.id === segmentId);
  if (plan.kind !== "suffix-recovery" || index < ledger.registeredPrefix ||
      index < 0 || ledger.segments[index].refundReference ||
      ledger.segments.some((segment) => segment.refundReference === reference)) {
    throw new Error("Invalid buyer refund");
  }
  return replace(ledger, index, { refundReference: reference });
}

/** Necessary identity condition only, not approval to hand over documents or burn. */
export function receiptRedemptionIdentityMatches(ledger: ReceiptLedger): boolean {
  return ledger.owner === ledger.registeredHolder;
}
