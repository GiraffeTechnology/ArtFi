import { describe, expect, it, vi } from "vitest";
import { getAddress, hashStruct, hashTypedData, type Address, type Hex } from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { saleIntentTypes } from "./whole-artwork-intent";
import { nftTaskJournalDigest } from "./nft/task-journal";
import { projectWholeReceiptApprovalBusiness } from "./whole-receipt-business";
import {
  assertWholeReceiptApprovalPlan,
  createWholeReceiptApprovalCommitments,
  WHOLE_RECEIPT_ASSOCIATION_SCHEMA,
  WHOLE_RECEIPT_BUSINESS_SCHEMA,
} from "./whole-receipt-commitments";
vi.mock("server-only", () => ({}));

const h = (c: string) => `0x${c.repeat(64)}` as Hex;
const a = (c: string) => `0x${c.repeat(40)}` as Address;
type Phase = "funded" | "registered" | "paid";
const correspondenceKeys = [
  "settlementId",
  "assetRecordHash",
  "oracleSourceId",
  "requestHash",
  "executionReferenceHash",
  "previousSegment",
  "oldCertificateHash",
  "warehouseReceiptHash",
] as const;

function fixture(phase: Phase = "funded") {
  const business = {
    kind: "transaction" as const,
    chainId: 560048 as const,
    request: { account: a("b") },
    wholeReceipt: {
      schemaVersion: 1 as const,
      phase,
      segmentId:
        "0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9" as Hex,
      domain: { chainId: 560048 as const, verifyingContract: a("3") },
      sale: {
        seller: a("a"),
        collection: a("1"),
        tokenId: "7",
        paymentToken: a("2"),
        price: "100",
        buyer: a("b"),
        salt: "1",
        startsAt: 1000,
        endsAt: 2000,
        epoch: "0",
      },
      correspondence: {
        settlementId: h("1"),
        assetRecordHash: h("2"),
        oracleSourceId: h("3"),
        requestHash: h("4"),
        executionReferenceHash: h("5"),
        previousSegment: h("0"),
        oldCertificateHash: h("6"),
        warehouseReceiptHash: h("7"),
      },
      ...(phase === "registered"
        ? {
            kitRegistration: { version: "2", proofHash: h("e") },
          }
        : {}),
    },
  };
  const binding = {
    tenant: "artfi",
    origin: "https://artfi.example:9445",
    taskId: "receipt-task",
    actor: a("b"),
    escrow: a("3"),
    runtimeCodeHash: h("a"),
  };
  return { business, binding };
}
type Fixture = ReturnType<typeof fixture>;
function resegment(f: Fixture) {
  const r = f.business.wholeReceipt;
  const sale = r.sale;
  r.segmentId = hashTypedData({
    domain: {
      name: "ArtFi Whole Artwork Receipt Settlement",
      version: "1",
      ...r.domain,
    },
    types: {
      ReceiptAuthorization: [
        { name: "saleIntentHash", type: "bytes32" },
        ...correspondenceKeys.map((name) => ({
          name,
          type: "bytes32" as const,
        })),
      ],
    },
    primaryType: "ReceiptAuthorization",
    message: {
      saleIntentHash: hashStruct({
        data: {
          ...sale,
          tokenId: BigInt(sale.tokenId),
          price: BigInt(sale.price),
          salt: BigInt(sale.salt),
          epoch: BigInt(sale.epoch),
        },
        types: saleIntentTypes,
        primaryType: "SaleIntent",
      }),
      ...r.correspondence,
    },
  });
}
function native(f: Fixture) {
  const principal = {
    kind: "task" as const,
    taskId: f.binding.taskId,
    taskDigest: h("8"),
    executorDigest: h("9"),
    grantReference: "grant:example",
    grantPolicyVersion: "1",
    operationId: `receipt:${f.business.wholeReceipt.phase}`,
  };
  const { kind: _, ...binding } = principal;
  return {
    ...structuredClone(f.business),
    id: "plan_receipt_example_0001",
    operationId: `native_${kernelRequestDigest(binding)}`,
    taskPrincipal: principal,
  };
}
function commitments(f: Fixture) {
  return createWholeReceiptApprovalCommitments(f.business, f.binding);
}
function expected(f: Fixture) {
  const result = commitments(f);
  return {
    receiptPlanDigest: result.receiptPlanDigest,
    receiptJournalBindingHash: result.receiptJournalBindingHash,
  };
}
const refused = /RECEIPT_APPROVAL_COMMITMENT_REFUSED/;

describe("whole receipt pregrant content commitments", () => {
  it.each(["funded", "registered", "paid"] as const)(
    "produces %s commitments without a grant or transport ID",
    (phase) => {
      const f = fixture(phase);
      const result = commitments(f);
      expect(Object.keys(result.business).sort()).toEqual([
        "chainId",
        "kind",
        "request",
        "wholeReceipt",
      ]);
      expect(result.receiptPlanDigest).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.receiptJournalBindingHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.authorization).toBe("NOT_ESTABLISHED");
      expect(WHOLE_RECEIPT_BUSINESS_SCHEMA).not.toBe(
        WHOLE_RECEIPT_ASSOCIATION_SCHEMA,
      );
      expect(Object.isFrozen(result.business.wholeReceipt.sale)).toBe(true);
      expect(Object.isFrozen(result.binding)).toBe(true);
    },
  );
  it("records the exact independent association fields", () => {
    const f = fixture();
    const result = commitments(f);
    expect(result.association).toEqual({
      schema: WHOLE_RECEIPT_ASSOCIATION_SCHEMA,
      tenant: f.binding.tenant,
      origin: f.binding.origin,
      taskId: f.binding.taskId,
      actor: f.binding.actor,
      phase: "funded",
      escrow: f.binding.escrow,
      runtimeCodeHash: f.binding.runtimeCodeHash,
      segmentId: f.business.wholeReceipt.segmentId,
      businessDigest: result.receiptPlanDigest,
    });
    expect(Object.keys(result.association).sort()).toEqual([
      "actor",
      "businessDigest",
      "escrow",
      "origin",
      "phase",
      "runtimeCodeHash",
      "schema",
      "segmentId",
      "taskId",
      "tenant",
    ]);
  });
  it("detaches source and binding before returning", () => {
    const f = fixture();
    const result = commitments(f);
    f.business.wholeReceipt.sale.price = "999";
    f.binding.runtimeCodeHash = h("f");
    expect(result.business.wholeReceipt.sale.price).toBe("100");
    expect(result.binding.runtimeCodeHash).toBe(h("a"));
  });
  it("binds registered proof version and proof hash", () => {
    const f = fixture("registered");
    const before = commitments(f);
    f.business.wholeReceipt.kitRegistration!.version = "3";
    const version = commitments(f);
    expect(version.receiptPlanDigest).not.toBe(before.receiptPlanDigest);
    f.business.wholeReceipt.kitRegistration!.proofHash = h("f");
    expect(commitments(f).receiptPlanDigest).not.toBe(
      version.receiptPlanDigest,
    );
  });
  it("binds the phase even when segment authorization is unchanged", () => {
    const funded = commitments(fixture("funded"));
    const paid = commitments(fixture("paid"));
    expect(paid.receiptPlanDigest).not.toBe(funded.receiptPlanDigest);
    expect(paid.receiptJournalBindingHash).not.toBe(
      funded.receiptJournalBindingHash,
    );
  });
  it.each(["tokenId", "price", "salt", "epoch"] as const)(
    "binds a valid changed sale %s",
    (key) => {
      const f = fixture();
      const before = commitments(f);
      f.business.wholeReceipt.sale[key] = "101";
      resegment(f);
      const after = commitments(f);
      expect(after.receiptPlanDigest).not.toBe(before.receiptPlanDigest);
      expect(after.receiptJournalBindingHash).not.toBe(
        before.receiptJournalBindingHash,
      );
    },
  );
  it.each(["seller", "collection", "paymentToken", "buyer"] as const)(
    "binds a valid changed sale %s address",
    (key) => {
      const f = fixture();
      const before = commitments(f);
      f.business.wholeReceipt.sale[key] = a("c");
      if (key === "buyer") {
        f.business.request.account = a("c");
        f.binding.actor = a("c");
      }
      resegment(f);
      expect(commitments(f).receiptPlanDigest).not.toBe(
        before.receiptPlanDigest,
      );
    },
  );
  it.each(["startsAt", "endsAt"] as const)(
    "binds a valid changed sale %s time",
    (key) => {
      const f = fixture();
      const before = commitments(f);
      f.business.wholeReceipt.sale[key] = key === "startsAt" ? 900 : 2100;
      resegment(f);
      expect(commitments(f).receiptPlanDigest).not.toBe(
        before.receiptPlanDigest,
      );
    },
  );
  it("binds a consistent changed chain and escrow domain", () => {
    const f = fixture();
    const before = commitments(f);
    Object.assign(f.business, { chainId: 31337 });
    Object.assign(f.business.wholeReceipt.domain, { chainId: 31337 });
    resegment(f);
    const chain = commitments(f);
    expect(chain.receiptPlanDigest).not.toBe(before.receiptPlanDigest);
    f.business.wholeReceipt.domain.verifyingContract = a("c");
    f.binding.escrow = a("c");
    resegment(f);
    const escrow = commitments(f);
    expect(escrow.receiptPlanDigest).not.toBe(chain.receiptPlanDigest);
    expect(escrow.receiptJournalBindingHash).not.toBe(
      chain.receiptJournalBindingHash,
    );
  });
  it.each(correspondenceKeys)("binds correspondence %s", (key) => {
    const f = fixture();
    const before = commitments(f);
    f.business.wholeReceipt.correspondence[key] = h("f");
    resegment(f);
    expect(commitments(f).receiptPlanDigest).not.toBe(before.receiptPlanDigest);
  });
  it.each(["tenant", "origin", "taskId", "runtimeCodeHash"] as const)(
    "binds installation %s without changing business content",
    (key) => {
      const f = fixture();
      const before = commitments(f);
      const values = {
        tenant: "other",
        origin: "https://other.example:9445",
        taskId: "other-task",
        runtimeCodeHash: h("f"),
      };
      Object.assign(f.binding, { [key]: values[key] });
      const after = commitments(f);
      expect(after.receiptPlanDigest).toBe(before.receiptPlanDigest);
      expect(after.receiptJournalBindingHash).not.toBe(
        before.receiptJournalBindingHash,
      );
    },
  );
  it("rejects actor and escrow substitution", () => {
    for (const key of ["actor", "escrow"] as const) {
      const f = fixture();
      f.binding[key] = a("c");
      expect(() => commitments(f)).toThrow(refused);
    }
  });
  it("normalizes validated business hex values to Wallet's canonical case", () => {
    const f = fixture("registered");
    const before = commitments(f);
    const bindingBefore = { ...f.binding };
    const upper = (x: string) => x.toUpperCase().replace(/^0X/, "0x");
    const r = f.business.wholeReceipt;
    f.business.request.account = getAddress(f.business.request.account);
    r.segmentId = upper(r.segmentId) as Hex;
    r.domain.verifyingContract = getAddress(r.domain.verifyingContract);
    for (const key of [
      "seller",
      "collection",
      "paymentToken",
      "buyer",
    ] as const)
      r.sale[key] = getAddress(r.sale[key]);
    for (const key of correspondenceKeys)
      r.correspondence[key] = upper(r.correspondence[key]) as Hex;
    r.kitRegistration!.proofHash = upper(r.kitRegistration!.proofHash) as Hex;
    expect(f.binding).toEqual(bindingBefore);
    expect(commitments(f)).toEqual(before);
  });
  it("normalizes validated installation hex without mutating its source", () => {
    const f = fixture("registered");
    const before = commitments(f);
    f.binding.actor = getAddress(f.binding.actor);
    f.binding.runtimeCodeHash = f.binding.runtimeCodeHash
      .toUpperCase()
      .replace(/^0X/, "0x") as Hex;
    const supplied = { ...f.binding };
    expect(f.binding.runtimeCodeHash).not.toBe(before.binding.runtimeCodeHash);
    expect(commitments(f)).toEqual(before);
    expect(f.binding).toEqual(supplied);
  });
  it("rejects an invalid installation address checksum", () => {
    const f = fixture("registered");
    f.binding.actor = f.binding.actor.toUpperCase().replace(/^0X/, "0x") as Address;
    expect(f.binding.actor).not.toBe(getAddress(a("b")));
    expect(() => commitments(f)).toThrow(refused);
  });
  it("does not accept a native plan as pregrant input", () => {
    const f = fixture();
    expect(() =>
      createWholeReceiptApprovalCommitments(native(f), f.binding),
    ).toThrow(refused);
  });
  it("preserves phase, domain and registered-proof validation", () => {
    const f = fixture("registered");
    delete f.business.wholeReceipt.kitRegistration;
    expect(() => commitments(f)).toThrow(refused);
    const wrong = fixture();
    wrong.business.wholeReceipt.domain.chainId = 31337 as 560048;
    expect(() => projectWholeReceiptApprovalBusiness(wrong.business)).toThrow();
  });
  it("rejects aliased fields and accessors without invoking them", () => {
    const f = fixture();
    let reads = 0;
    const binding = { ...f.binding };
    Object.defineProperty(binding, "actor", {
      enumerable: true,
      get() {
        reads++;
        return f.binding.actor;
      },
    });
    expect(() =>
      createWholeReceiptApprovalCommitments(f.business, binding),
    ).toThrow(refused);
    expect(reads).toBe(0);
    expect(() =>
      createWholeReceiptApprovalCommitments(f.business, {
        ...f.binding,
        nonce: "0",
      }),
    ).toThrow(refused);
  });
  it("retains the entire independently verified postgrant identity", () => {
    const f = fixture();
    const plan = native(f);
    const result = assertWholeReceiptApprovalPlan(plan, f.binding, expected(f));
    expect(result.nativePlan).toEqual(plan);
    expect(result.authorization).toBe("NOT_ESTABLISHED");
    expect(nftTaskJournalDigest(result.nativePlan)).not.toBe(
      result.receiptPlanDigest.slice(2),
    );
  });
  it("keeps content stable for a new grant while native identity changes", () => {
    const f = fixture();
    const first = native(f);
    const second = native(f);
    second.taskPrincipal.grantReference = "grant:replacement";
    const { kind: _, ...binding } = second.taskPrincipal;
    second.operationId = `native_${kernelRequestDigest(binding)}`;
    second.id = "plan_receipt_replacement";
    const result = assertWholeReceiptApprovalPlan(
      second,
      f.binding,
      expected(f),
    );
    expect(result.receiptPlanDigest).toBe(expected(f).receiptPlanDigest);
    expect(nftTaskJournalDigest(second)).not.toBe(nftTaskJournalDigest(first));
    expect(result.nativePlan.taskPrincipal.grantReference).toBe(
      "grant:replacement",
    );
    expect(result.authorization).toBe("NOT_ESTABLISHED");
  });
  it("rejects a changed principal without its native operation ID", () => {
    const f = fixture();
    const plan = native(f);
    plan.taskPrincipal.grantReference = "grant:replacement";
    expect(() =>
      assertWholeReceiptApprovalPlan(plan, f.binding, expected(f)),
    ).toThrow(refused);
  });
  it("rejects another task even with a recomputed native ID", () => {
    const f = fixture();
    const plan = native(f);
    plan.taskPrincipal.taskId = "other-task";
    const { kind: _, ...binding } = plan.taskPrincipal;
    plan.operationId = `native_${kernelRequestDigest(binding)}`;
    expect(() =>
      assertWholeReceiptApprovalPlan(plan, f.binding, expected(f)),
    ).toThrow(refused);
  });
  it("rejects stale, incomplete or bare-native expected digests", () => {
    const f = fixture();
    const plan = native(f);
    for (const claims of [
      { receiptPlanDigest: h("0"), receiptJournalBindingHash: h("0") },
      { receiptPlanDigest: expected(f).receiptPlanDigest },
      { ...expected(f), receiptPlanDigest: nftTaskJournalDigest(plan) },
      { ...expected(f), receiptNonce: "0" },
    ])
      expect(() =>
        assertWholeReceiptApprovalPlan(plan, f.binding, claims),
      ).toThrow(refused);
  });
});
