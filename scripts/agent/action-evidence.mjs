import { kernelRequestDigest } from "./agent-kernel.mjs";
const hash = (x) => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const matches = (expected, actual) =>
  Object.entries(expected).every(([key, value]) =>
    typeof value === "string" && /^0x/.test(value)
      ? same(value, actual?.[key])
      : value === actual?.[key],
  );
// This verifies the normalized public evidence returned by the approved read
// adapter. It cannot authenticate an arbitrary provider or create Oracle trust.
export function verifyActionEvidence(leg, input) {
  const evidence = structuredClone(input);
  const unknown = (reason) =>
    Object.freeze({ state: "UNKNOWN", verified: false, reason });
  if (
    evidence?.mode !== leg.mode ||
    evidence.chainId !== leg.chainId ||
    typeof evidence.sourceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(evidence.sourceId) ||
    !Number.isSafeInteger(evidence.observedAt) ||
    evidence.observedAt < 0 ||
    evidence.callHash !== leg.callHash
  )
    return unknown("ACTION_EVIDENCE_BINDING_INVALID");
  if (
    ["SIGNED_ORDER_PUBLICATION", "NATIVE_NFT_SIGNATURE"].includes(
      leg.dispatch.kind,
    )
  ) {
    if (
      evidence.state !== "ORDER_VISIBLE" ||
      evidence.orderHash !== leg.orderKey ||
      !same(evidence.seller, leg.wallet) ||
      evidence.intentHash !== leg.orderKey ||
      evidence.orderBodyDigest !== kernelRequestDigest(leg.dispatch.args)
    )
      return unknown("SIGNED_ORDER_NOT_VERIFIED");
    return Object.freeze({
      state: "CONFIRMED",
      verified: true,
      kind: "ORDER_PUBLICATION",
      sourceId: evidence.sourceId,
      orderKey: leg.orderKey,
      evidenceDigest: kernelRequestDigest(evidence),
      observedAt: evidence.observedAt,
    });
  }
  const tx = evidence.transaction;
  if (
    !tx ||
    !hash(tx.hash) ||
    !hash(tx.blockHash) ||
    !Number.isSafeInteger(tx.blockNumber) ||
    tx.blockNumber < 1 ||
    !same(tx.to, leg.market) ||
    !same(tx.from, leg.wallet) ||
    tx.callHash !== leg.callHash ||
    (leg.transactionValue !== undefined && tx.value !== leg.transactionValue) ||
    evidence.canonicalBlockHash !== tx.blockHash ||
    !Number.isSafeInteger(evidence.finalizedBlockNumber) ||
    evidence.finalizedBlockNumber < tx.blockNumber ||
    !Array.isArray(evidence.events) ||
    evidence.events.length > 128
  )
    return unknown("CHAIN_OUTCOME_UNPROVEN");
  if (tx.status !== 1)
    return unknown(
      tx.status === 0 ? "CHAIN_TRANSACTION_REVERTED" : "CHAIN_OUTCOME_UNPROVEN",
    );
  const seen = new Set();
  for (const event of evidence.events) {
    if (
      event.removed !== false ||
      !Number.isSafeInteger(event.index) ||
      event.index < 0 ||
      seen.has(event.index) ||
      event.transactionHash !== tx.hash ||
      event.blockHash !== tx.blockHash
    )
      return unknown("ACTION_EVENT_CONTEXT_INVALID");
    seen.add(event.index);
  }
  const events = evidence.events.filter(
    (event) =>
      same(event.address, leg.market) &&
      event.name === leg.expected.name &&
      matches(leg.expected.args, event.args),
  );
  if (events.length !== 1) return unknown("ACTION_EVENT_MISMATCH");
  if (leg.expected.name === "IntentFilled") {
    const filled = events[0].args.filledToDate;
    if (
      typeof filled !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(filled) ||
      BigInt(filled) < BigInt(leg.quantity) ||
      BigInt(filled) > BigInt(leg.expected.maxAmount)
    )
      return unknown("PARTIAL_FILL_ACCOUNTING_MISMATCH");
  }
  return Object.freeze({
    state: "CONFIRMED",
    verified: true,
    kind: "CHAIN_EVENT",
    sourceId: evidence.sourceId,
    ...(Number.isSafeInteger(tx.gasUsed) &&
    tx.gasUsed >= 0 &&
    tx.gasUsed <= 1000000000
      ? { gasUsed: tx.gasUsed }
      : {}),
    transactionHash: tx.hash,
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    eventName: leg.expected.name,
    eventArgs: events[0].args,
    orderKey: leg.orderKey,
    evidenceDigest: kernelRequestDigest(evidence),
    observedAt: evidence.observedAt,
  });
}
