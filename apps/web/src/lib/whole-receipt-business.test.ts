import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, hashStruct, hashTypedData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { saleIntentTypes } from "./whole-artwork-intent";
import { matchWholeReceiptBusiness, projectWholeReceiptBusiness } from "./whole-receipt-business";
vi.mock("server-only", () => ({}));

const h = (c: string) => `0x${c.repeat(64)}` as Hex;
const a = (c: string) => `0x${c.repeat(40)}` as Address;
const saleTuple = "(address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch)";
const correspondenceTuple = "(bytes32 settlementId,bytes32 assetRecordHash,bytes32 oracleSourceId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment,bytes32 oldCertificateHash,bytes32 warehouseReceiptHash)";
const abi = parseAbi([`function fund(${saleTuple} sale,${correspondenceTuple} correspondence,bytes signature)`, "function confirmRegistration(bytes32 id,bytes evidence)", "function paySeller(bytes32 id)"]);
const evidence = parseAbiParameters(`${saleTuple} sale,${correspondenceTuple} correspondence,uint64 version,bytes proof`);
const correspondenceKeys = ["settlementId", "assetRecordHash", "oracleSourceId", "requestHash", "executionReferenceHash", "previousSegment", "oldCertificateHash", "warehouseReceiptHash"] as const;

function fixture(phase: "funded" | "registered" | "paid" = "funded") {
  const taskPrincipal = { kind: "task" as const, taskId: "receipt-task", taskDigest: h("8"), executorDigest: h("9"), grantReference: "grant:example", grantPolicyVersion: "1", operationId: `receipt:${phase}` };
  const { kind: _, ...binding } = taskPrincipal;
  const sale = { seller: a("a"), collection: a("1"), tokenId: "7", paymentToken: a("2"), price: "100", buyer: a("b"), salt: "1", startsAt: 1000, endsAt: 2000, epoch: "0" };
  const correspondence = { settlementId: h("1"), assetRecordHash: h("2"), oracleSourceId: h("3"), requestHash: h("4"), executionReferenceHash: h("5"), previousSegment: h("0"), oldCertificateHash: h("6"), warehouseReceiptHash: h("7") };
  const native = { id: "plan_receipt_example_0001", operationId: `native_${kernelRequestDigest(binding)}`, chainId: 560048 as const,
    taskPrincipal, request: { account: sale.buyer }, kind: "transaction" as const,
    wholeReceipt: { schemaVersion: 1 as const, phase, segmentId: "0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9" as Hex,
      domain: { chainId: 560048 as const, verifyingContract: a("3") }, sale, correspondence,
      ...(phase === "registered" ? { kitRegistration: { version: "2", proofHash: keccak256("0x1234") } } : {}) } };
  const policy = { schema: "8415-agent-task/1", taskId: "receipt-task", tenant: "artfi", origin: "https://artfi.example:9445", chainId: "560048", actor: sale.buyer, expiresAt: "2000000000",
    fees: { perOperationWei: "1000000", totalWei: "3000000" }, intent: { kind: "artfi-receipt", handlerId: "artfi:whole-receipt:v1", escrow: a("3"), runtimeCodeHash: h("a"), segmentId: native.wholeReceipt.segmentId,
      sale: { ...sale, startsAt: "1000", endsAt: "2000" }, correspondence: structuredClone(correspondence),
      phases: [{ phase, nonce: "9007199254740991", calldataHash: h("f"), planDigest: h("c"), journalBindingHash: h("d"), gasLimit: "21000", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "1" }],
      recovery: { funding: "once", payout: "once", unknownOutcome: "reconcile-only" } } };
  const wire = { account: sale.buyer, chainId: "560048", to: a("3"), data: "0x" as Hex, value: "0", nonce: "9007199254740991", gasLimit: "21000", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "1" };
  const f = { native, policy, wire };
  encode(f);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function trade(f: Fixture) {
  const s = f.native.wholeReceipt.sale;
  return { ...s, tokenId: BigInt(s.tokenId), price: BigInt(s.price), salt: BigInt(s.salt), epoch: BigInt(s.epoch) };
}
function encode(f: Fixture, innerSale = trade(f), innerCorrespondence = f.native.wholeReceipt.correspondence, version = 2n, proof: Hex = "0x1234") {
  const r = f.native.wholeReceipt;
  f.wire.data = r.phase === "funded" ? encodeFunctionData({ abi, functionName: "fund", args: [innerSale, innerCorrespondence, "0x1234"] })
    : r.phase === "paid" ? encodeFunctionData({ abi, functionName: "paySeller", args: [r.segmentId] })
      : encodeFunctionData({ abi, functionName: "confirmRegistration", args: [r.segmentId, encodeAbiParameters(evidence, [innerSale, innerCorrespondence, version, proof])] });
  f.policy.intent.phases[0]!.calldataHash = keccak256(f.wire.data);
}
function resegment(f: Fixture) {
  const r = f.native.wholeReceipt;
  r.segmentId = hashTypedData({ domain: { name: "ArtFi Whole Artwork Receipt Settlement", version: "1", ...r.domain },
    types: { ReceiptAuthorization: [{ name: "saleIntentHash", type: "bytes32" }, ...correspondenceKeys.map(name => ({ name, type: "bytes32" }))] }, primaryType: "ReceiptAuthorization",
    message: { saleIntentHash: hashStruct({ data: trade(f), types: saleIntentTypes, primaryType: "SaleIntent" }), ...r.correspondence } });
  encode(f);
}
const match = (f: Fixture) => matchWholeReceiptBusiness(f.native, f.policy, f.wire);

describe("receipt business/native plan separation", () => {
  it.each(["funded", "registered", "paid"] as const)("accepts the existing %s ABI with an unsigned detached result", phase => {
    const f = fixture(phase), result = match(f);
    expect(result.business.wholeReceipt.segmentId).toBe("0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9");
    expect(result.nativePlan).toEqual(f.native);
    expect(Object.keys(result.business).sort()).toEqual(["chainId", "kind", "request", "wholeReceipt"]);
    expect(result.phaseSlot.nonce).toBe("9007199254740991");
    expect(result.authorization).toBe("NOT_ESTABLISHED");
    expect(JSON.stringify(result)).not.toContain('"0x1234"');
    expect(Object.isFrozen(result.nativePlan.taskPrincipal)).toBe(true);
    f.native.wholeReceipt.sale.price = "200";
    expect(result.business.wholeReceipt.sale.price).toBe("100");
  });
  it("changes native identity for a new grant but leaves the business projection unchanged", () => {
    const f = fixture(), old = projectWholeReceiptBusiness(f.native);
    f.native.taskPrincipal.grantReference = "grant:replacement";
    const { kind: _, ...binding } = f.native.taskPrincipal;
    expect(() => projectWholeReceiptBusiness(f.native)).toThrow();
    f.native.operationId = `native_${kernelRequestDigest(binding)}`;
    f.native.id = "plan_receipt_replacement";
    const next = projectWholeReceiptBusiness(f.native);
    expect(next.business).toEqual(old.business);
    expect(next.nativePlan.taskPrincipal).not.toEqual(old.nativePlan.taskPrincipal);
  });
  it.each(correspondenceKeys)("refuses a self-consistent foreign %s commitment", key => {
    const f = fixture(); f.native.wholeReceipt.correspondence[key] = h("e"); resegment(f);
    expect(() => projectWholeReceiptBusiness(f.native)).not.toThrow();
    // Even changing the slot calldata hash does not rewrite the approved terms.
    expect(() => match(f)).toThrow("RECEIPT_BUSINESS_BINDING_REFUSED");
  });
  it.each(["tokenId", "price", "salt", "epoch"] as const)("refuses changed %s despite canonical calldata", key => {
    const f = fixture(); f.native.wholeReceipt.sale[key] = String(BigInt(f.native.wholeReceipt.sale[key]) + 1n); resegment(f);
    expect(() => match(f)).toThrow();
  });
  it("refuses domain, task, actor, phase, and missing proof downgrades", () => {
    const mutations: ((f: Fixture) => void)[] = [
      f => { f.policy.taskId = "foreign-task"; },
      f => { f.policy.chainId = "31337"; },
      f => { f.policy.actor = a("c"); },
      f => { f.policy.intent.escrow = a("4"); },
      f => { f.policy.intent.phases[0]!.phase = "paid"; },
      f => { f.native.wholeReceipt.domain.verifyingContract = a("4"); },
      f => { f.native.wholeReceipt.kitRegistration = undefined; },
    ];
    for (const mutate of mutations) { const f = fixture("registered"); mutate(f); expect(() => match(f)).toThrow(); }
  });
  it("binds registration version, proof hash, all inner sale/correspondence and the segment", () => {
    const invalid = [
      (f: Fixture) => encode(f, { ...trade(f), price: 101n }),
      (f: Fixture) => encode(f, trade(f), { ...f.native.wholeReceipt.correspondence, warehouseReceiptHash: h("e") }),
      (f: Fixture) => encode(f, trade(f), f.native.wholeReceipt.correspondence, 3n),
      (f: Fixture) => encode(f, trade(f), f.native.wholeReceipt.correspondence, 2n, "0xabcd"),
      (f: Fixture) => { f.wire.data = encodeFunctionData({ abi, functionName: "confirmRegistration", args: [h("e"), encodeAbiParameters(evidence, [trade(f), f.native.wholeReceipt.correspondence, 2n, "0x1234"])] }); f.policy.intent.phases[0]!.calldataHash = keccak256(f.wire.data); },
    ];
    for (const mutate of invalid) { const f = fixture("registered"); mutate(f); expect(() => match(f)).toThrow(); }
  });
  it("rejects changed nonce/fees, appended ABI bytes, and an unapproved selector", () => {
    const invalid = [
      (f: Fixture) => { f.wire.nonce = "9007199254740990"; },
      (f: Fixture) => { f.wire.gasLimit = "21001"; },
      (f: Fixture) => { f.policy.intent.phases[0]!.maxPriorityFeePerGasWei = "3"; },
      (f: Fixture) => { f.policy.fees.totalWei = "1"; },
      (f: Fixture) => { f.wire.data = `${f.wire.data}${"00".repeat(32)}`; f.policy.intent.phases[0]!.calldataHash = keccak256(f.wire.data); },
      (f: Fixture) => { f.wire.data = encodeFunctionData({ abi, functionName: "paySeller", args: [f.native.wholeReceipt.segmentId] }); f.policy.intent.phases[0]!.calldataHash = keccak256(f.wire.data); },
    ];
    for (const mutate of invalid) { const f = fixture(); mutate(f); expect(() => match(f)).toThrow(); }
  });
  it("rejects phase/nonce reuse and noncanonical decimal policies", () => {
    for (const nonce of ["01", "9007199254740992", "1e3", "-1"]) {
      const f = fixture(); f.policy.intent.phases[0]!.nonce = nonce; f.wire.nonce = nonce;
      expect(() => match(f)).toThrow();
    }
    const f = fixture(); f.policy.intent.phases.push(structuredClone(f.policy.intent.phases[0]!));
    expect(() => match(f)).toThrow();
  });
  it("does not execute getters or accept aliased/secret/unknown or prototype fields", () => {
    let reads = 0;
    const f = fixture(), before = structuredClone(f.native);
    Object.defineProperty(f.native, "wholeReceipt", { enumerable: true, get() { reads++; return before.wholeReceipt; } });
    expect(() => projectWholeReceiptBusiness(f.native)).toThrow(); expect(reads).toBe(0);
    for (const extra of [{ signature: "0x1234" }, { whole_receipt: before.wholeReceipt }, { sessionId: "session" }])
      expect(() => projectWholeReceiptBusiness({ ...before, ...extra })).toThrow();
    expect(() => projectWholeReceiptBusiness(Object.assign(Object.create(before), before))).toThrow();
    expect(() => projectWholeReceiptBusiness({ ...before, [Symbol("hidden")]: true })).toThrow();
  });
  it("retains slot digests only as opaque policy values, never an approval result", () => {
    const f = fixture(), before = match(f);
    f.policy.intent.phases[0]!.planDigest = h("e"); f.policy.intent.phases[0]!.journalBindingHash = h("f");
    const changed = match(f);
    expect(changed.business).toEqual(before.business);
    expect(changed.phaseSlot.planDigest).toBe(h("e"));
    expect(changed.authorization).toBe("NOT_ESTABLISHED");
  });
});
