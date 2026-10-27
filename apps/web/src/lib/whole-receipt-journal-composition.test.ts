import { describe, expect, it, vi } from "vitest";
import { createWholeReceiptApprovalCommitments } from "./whole-receipt-commitments";
import { encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { nftTaskJournalDigest } from "./nft/task-journal";
import {
  createWholeReceiptPreparedJournal,
  type ReceiptPreparationRuntime,
  type ReceiptJournalOperation,
  type ReceiptNativeJournal,
} from "./whole-receipt-prepared-journal";
import { createWholeReceiptNativeJournal } from "./whole-receipt-journal-composition";
vi.mock("server-only", () => ({}));
const h = (c: string) => `0x${c.repeat(64)}` as Hex,
  a = (c: string) => `0x${c.repeat(40)}`;
function fixture() {
  const principal = {
    kind: "task" as const,
    taskId: "receipt-task",
    taskDigest: h("8"),
    executorDigest: h("9"),
    grantReference: "grant:example",
    grantPolicyVersion: "1",
    operationId: "receipt-paid",
  };
  const { kind: _, ...binding } = principal;
  const native = {
    id: "plan_receipt_example_0001",
    operationId: `native_${kernelRequestDigest(binding)}`,
    chainId: 560048 as const,
    taskPrincipal: principal,
    kind: "transaction" as const,
    request: { account: a("b") },
    wholeReceipt: {
      schemaVersion: 1 as const,
      phase: "paid" as const,
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
    },
  };
  const wire = {
    account: a("b"),
    chainId: "560048",
    to: a("3"),
    value: "0",
    data: encodeFunctionData({
      abi: parseAbi(["function paySeller(bytes32 id)"]),
      functionName: "paySeller",
      args: [native.wholeReceipt.segmentId],
    }),
    nonce: "2",
    gasLimit: "21000",
    maxFeePerGasWei: "2",
    maxPriorityFeePerGasWei: "1",
  };
  const approval = createWholeReceiptApprovalCommitments(
    {
      kind: native.kind,
      chainId: native.chainId,
      request: native.request,
      wholeReceipt: native.wholeReceipt,
    },
    {
      tenant: "artfi",
      origin: "https://artfi.example:9445",
      taskId: principal.taskId,
      actor: native.request.account,
      escrow: native.wholeReceipt.domain.verifyingContract,
      runtimeCodeHash: h("e"),
    },
  );
  const slot = {
    phase: "paid",
    nonce: "2",
    calldataHash: keccak256(wire.data),
    planDigest: approval.receiptPlanDigest,
    journalBindingHash: approval.receiptJournalBindingHash,
    gasLimit: "21000",
    maxFeePerGasWei: "2",
    maxPriorityFeePerGasWei: "1",
  };
  const claimed = {
    ...binding,
    phase: "paid" as const,
    planDigest: slot.planDigest,
    journalBindingHash: slot.journalBindingHash,
  };
  const policy = {
    schema: "8415-agent-task/1",
    taskId: "receipt-task",
    tenant: "artfi",
    origin: "https://artfi.example:9445",
    chainId: "560048",
    actor: a("b"),
    expiresAt: "10",
    fees: { perOperationWei: "100000", totalWei: "100000" },
    intent: {
      kind: "artfi-receipt",
      handlerId: "artfi:whole-receipt:v1",
      escrow: a("3"),
      runtimeCodeHash: h("e"),
      segmentId: native.wholeReceipt.segmentId,
      sale: { ...native.wholeReceipt.sale, startsAt: "1000", endsAt: "2000" },
      correspondence: structuredClone(native.wholeReceipt.correspondence),
      phases: [slot],
      recovery: {
        funding: "once",
        payout: "once",
        unknownOutcome: "reconcile-only",
      },
    },
  };
  const snapshot = {
    task: { digest: principal.taskDigest, policy },
    executor: { digest: principal.executorDigest },
    expiresAtMs: 10000,
    scope: {
      phase: "paid",
      nonce: "2",
      planDigest: slot.planDigest,
      journalBindingHash: slot.journalBindingHash,
      actor: a("b"),
      chainId: "560048",
      escrow: a("3"),
      runtimeCodeHash: h("e"),
      segmentId: native.wholeReceipt.segmentId,
    },
  };
  const row: ReceiptJournalOperation = {
    id: native.operationId,
    wallet: a("b"),
    chainId: 560048,
    requestHash: nftTaskJournalDigest(native),
    revision: 1,
    status: "awaiting-wallet",
    walletStarted: false,
    plan: structuredClone(native),
    updatedAt: "2026-10-16T00:00:00Z",
  };
  const state = {
    held: false,
    now: 1000,
    revoked: false,
    stopped: false,
    purposes: [] as string[],
    journalCalls: 0,
    row: structuredClone(row),
    input: undefined as undefined | Parameters<ReceiptNativeJournal>,
    loseCreateAck: false,
    duplicate: false,
    beforeContext: undefined as undefined | (() => Promise<void>),
    afterJournal: undefined as undefined | (() => void),
  };
  const runtime: ReceiptPreparationRuntime = {
    state: "configured",
    inHeldGate: () => state.held,
    authority: {
      async withPreparation(_claim, purpose, action) {
        if (state.held) throw Error("SYNTHETIC_NESTED_GATE");
        if (
          purpose === "prepare" &&
          (state.revoked || state.now >= snapshot.expiresAtMs)
        )
          throw Error("SYNTHETIC_GRANT_INACTIVE");
        await state.beforeContext?.();
        state.purposes.push(purpose);
        state.held = true;
        const recheck = () => {
          if (!state.held || state.stopped)
            throw Error("SYNTHETIC_RUNTIME_STOPPED");
        };
        try {
          const result = await action(snapshot, recheck);
          if (state.duplicate) await action(snapshot, recheck);
          return result;
        } finally {
          state.held = false;
        }
      },
    },
  };
  const scopes: unknown[] = [],
    bodies: { action: string; operation: Record<string, unknown> }[] = [];
  let transportHeld = false;
  const config: Parameters<
    typeof createWholeReceiptNativeJournal
  >[0]["journalConfig"] = {
    url: "https://journal.fixture.invalid/internal/v1/nft/operations",
    peerId: "spiffe://fixture.invalid/artfi",
    async withCapability(scope, consumeCapability) {
      expect(state.held).toBe(true);
      scopes.push(structuredClone(scope));
      return consumeCapability("fixture-only-not-a-live-capability-token");
    },
    async transport(_url, init) {
      expect(state.held).toBe(true);
      transportHeld = true;
      state.journalCalls++;
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      state.input = [principal, body.action, body.operation];
      state.afterJournal?.();
      if (body.action === "create" && state.loseCreateAck)
        throw Error("SYNTHETIC_CREATE_ACK_UNKNOWN");
      return new Response(JSON.stringify(state.row));
    },
  };
  const port = createWholeReceiptNativeJournal({
    runtime,
    claimed,
    journalConfig: config,
    now: () => state.now,
  });

  return {
    principal,
    native,
    wire,
    policy,
    snapshot,
    state,
    runtime,
    config,
    scopes,
    bodies,
    transportHeld: () => transportHeld,
    claimed,
    port,
  };
}

describe("typed whole receipt native journal composition", () => {
  it("connects the complete unsigned business plan to the native wire inside one preparation context", async () => {
    const f = fixture();
    const result = await f.port.create(f.native, f.wire);
    expect(f.transportHeld()).toBe(true);
    expect(f.state.purposes).toEqual(["prepare"]);
    expect(f.scopes).toHaveLength(1);
    expect(f.bodies[0]).toEqual({
      action: "create",
      operation: {
        id: f.native.operationId,
        wallet: f.native.request.account,
        chainId: 560048,
        requestHash: nftTaskJournalDigest(f.native),
        revision: 0,
        status: "awaiting-wallet",
        walletStarted: false,
        plan: f.native,
        updatedAt: "",
      },
    });
    expect(result.operation.plan).toEqual(f.native);
    expect(JSON.stringify(f.bodies)).not.toContain(f.wire.data);
    expect(Object.keys(f.port).sort()).toEqual([
      "create",
      "operationId",
      "read",
    ]);
  });
  it("binds the same full principal and canonical plan/request digests at the capability boundary", async () => {
    const f = fixture();
    await f.port.create(f.native, f.wire);
    const scope = f.scopes[0] as Record<string, unknown>;
    expect(scope.principal).toEqual(f.principal);
    expect(scope.planDigest).toBe(nftTaskJournalDigest(f.native));
    expect(scope.requestDigest).toBe(nftTaskJournalDigest(f.bodies[0]));
    expect(scope.nativeOperationId).toBe(f.port.operationId);
  });
  it("keeps progressed idempotent creation metadata", async () => {
    const f = fixture();
    Object.assign(f.state.row, {
      status: "pending",
      walletStarted: true,
      transactionHash: h("F"),
      revision: 7,
    });
    const result = await f.port.create(f.native, f.wire);
    expect(result.operation).toEqual(f.state.row);
    expect(f.bodies).toHaveLength(1);
  });
  it.each(["review", "observe"] as const)(
    "retains read-only %s after expiry and revocation",
    async (purpose) => {
      const f = fixture();
      f.state.revoked = true;
      f.state.now = 20000;
      expect((await f.port.read(purpose)).operation.id).toBe(
        f.port.operationId,
      );
      expect(f.bodies).toEqual([
        { action: "get", operation: { id: f.port.operationId } },
      ]);
      expect(f.state.purposes).toEqual([purpose]);
    },
  );
  it("reconciles a lost create response through the original get identity without a duplicate write", async () => {
    const f = fixture();
    f.state.loseCreateAck = true;
    await expect(f.port.create(f.native, f.wire)).rejects.toThrow(
      "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
    );
    f.state.loseCreateAck = false;
    await f.port.read();
    expect(f.bodies.map((x) => x.action)).toEqual(["create", "get"]);
    expect(f.bodies.every((x) => x.operation.id === f.port.operationId)).toBe(
      true,
    );
  });
  it("withholds a response that changes the complete task principal", async () => {
    const f = fixture();
    f.state.row.plan.taskPrincipal.grantReference = "grant:foreign";
    await expect(f.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect(f.bodies).toHaveLength(1);
  });
  it("rejects a changed native request digest even when the principal remains the same", async () => {
    const f = fixture();
    f.state.row.requestHash = "f".repeat(64);
    await expect(f.port.read()).rejects.toThrow("RECEIPT_JOURNAL_ROW_REFUSED");
  });
  it("preserves the original detached reviewed content across asynchronous context entry", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    f.state.beforeContext = () => pending;
    const result = f.port.create(f.native, f.wire);
    f.native.wholeReceipt.sale.price = "999";
    f.wire.nonce = "9";
    release();
    expect((await result).operation.plan.wholeReceipt.sale.price).toBe("100");
    expect(
      (f.bodies[0]!.operation.plan as ReceiptJournalOperation["plan"])
        .wholeReceipt.sale.price,
    ).toBe("100");
  });
  it("does not substitute a session or global transport when fixed native configuration is absent", async () => {
    const f = fixture();
    const port = createWholeReceiptNativeJournal({
      runtime: f.runtime,
      claimed: f.claimed,
      journalConfig: {
        ...f.config,
        url: "http://journal.fixture.invalid/internal/v1/nft/operations",
      },
      now: () => f.state.now,
    });
    await expect(port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect(f.bodies).toHaveLength(0);
  });
  it("does not duplicate a journal request when the preparation callback is repeated", async () => {
    const f = fixture();
    f.state.duplicate = true;
    await expect(f.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_CONTEXT_REENTRY_REFUSED",
    );
    expect(f.bodies).toHaveLength(1);
  });
  it("rechecks the original context after native response before releasing the operation", async () => {
    const f = fixture();
    f.state.afterJournal = () => {
      f.state.stopped = true;
    };
    await expect(f.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect(f.state.held).toBe(false);
  });
});
