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
  const journal: ReceiptNativeJournal = async (...input) => {
    expect(state.held).toBe(true);
    state.journalCalls++;
    state.input = structuredClone(input);
    state.afterJournal?.();
    if (input[1] === "create" && state.loseCreateAck)
      throw Error("SYNTHETIC_CREATE_ACK_UNKNOWN");
    return structuredClone(state.row);
  };
  const port = createWholeReceiptPreparedJournal({
    runtime,
    claimed,
    journal,
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
    journal,
    claimed,
    port,
  };
}

describe("receipt preparation and non-send native journal port", () => {
  it("refuses legacy opaque commitments before writing the native journal", async () => {
    const f = fixture();
    Object.assign(f.policy.intent.phases[0]!, {
      planDigest: h("c"),
      journalBindingHash: h("d"),
    });
    Object.assign(f.claimed, {
      planDigest: h("c"),
      journalBindingHash: h("d"),
    });
    Object.assign(f.snapshot.scope, {
      planDigest: h("c"),
      journalBindingHash: h("d"),
    });
    const port = createWholeReceiptPreparedJournal({
      runtime: f.runtime,
      claimed: f.claimed,
      journal: f.journal,
      now: () => f.state.now,
    });
    await expect(port.create(f.native, f.wire)).rejects.toThrow(
      "RECEIPT_JOURNAL_APPROVAL_COMMITMENT_REFUSED",
    );
    expect(f.state.journalCalls).toBe(0);
  });
  it.each(["tenant", "origin", "runtimeCodeHash"] as const)(
    "rejects a stale installation %s on both preparation and recovery",
    async (key) => {
      const f = fixture();
      if (key === "runtimeCodeHash") {
        f.policy.intent.runtimeCodeHash = h("6");
        f.snapshot.scope.runtimeCodeHash = h("6");
      } else
        f.policy[key] =
          key === "tenant" ? "another-artfi" : "https://another.example:9445";
      await expect(f.port.create(f.native, f.wire)).rejects.toThrow(
        "RECEIPT_JOURNAL_APPROVAL_COMMITMENT_REFUSED",
      );
      expect(f.state.journalCalls).toBe(0);
      await expect(f.port.read()).rejects.toThrow(
        "RECEIPT_JOURNAL_APPROVAL_COMMITMENT_REFUSED",
      );
      expect(f.state.journalCalls).toBe(1);
    },
  );
  it("recomputes the association after the journal await before releasing a recovered row", async () => {
    const f = fixture();
    f.state.afterJournal = () => {
      f.policy.origin = "https://changed.example:9445";
    };
    await expect(f.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_APPROVAL_COMMITMENT_REFUSED",
    );
    expect(f.state.journalCalls).toBe(1);
    expect(f.state.held).toBe(false);
  });

  it("creates the full unsigned native plan inside preparation, with no wire, signature or provider action", async () => {
    const f = fixture(),
      result = await f.port.create(f.native, f.wire);
    expect(f.state.purposes).toEqual(["prepare"]);
    expect(f.state.input?.[0]).toEqual(f.principal);
    expect(f.state.input?.[1]).toBe("create");
    expect(f.state.input?.[2]).toMatchObject({
      id: f.native.operationId,
      requestHash: nftTaskJournalDigest(f.native),
      walletStarted: false,
      revision: 0,
      status: "awaiting-wallet",
      plan: f.native,
    });
    expect(JSON.stringify(f.state.input)).not.toContain(f.wire.data);
    expect(result.operation).toEqual(f.state.row);
    expect(result.executionAuthorization).toBe("NOT_ESTABLISHED");
    expect(result.approvalCommitments).toBe("CONTENT_MATCHED");
    expect(Object.isFrozen(result.operation.plan.taskPrincipal)).toBe(true);
    expect(Object.keys(f.port).sort()).toEqual([
      "create",
      "operationId",
      "read",
    ]);
  });
  it("preserves the current idempotent-create row instead of resetting progressed lifecycle", async () => {
    const f = fixture();
    f.state.row.status = "pending";
    f.state.row.walletStarted = true;
    f.state.row.transactionHash = h("f");
    f.state.row.revision = 7;
    const result = await f.port.create(f.native, f.wire);
    expect(result.operation.status).toBe("pending");
    expect(result.operation.walletStarted).toBe(true);
    expect(result.operation.transactionHash).toBe(h("f"));
    expect(result.operation.revision).toBe(7);
  });
  it("preserves a valid historic mixed-case public transaction hash during recovery", async () => {
    const f = fixture();
    f.state.row.status = "pending";
    f.state.row.walletStarted = true;
    f.state.row.transactionHash = h("F");
    const result = await f.port.read();
    expect(result.operation.transactionHash).toBe(h("F"));
  });
  it.each(["review", "observe"] as const)(
    "reads through the real %s context after expiry/revocation without renewed send authority",
    async (purpose) => {
      const f = fixture();
      f.state.now = 20000;
      f.state.revoked = true;
      f.state.row.walletStarted = true;
      const result = await f.port.read(purpose);
      expect(f.state.purposes).toEqual([purpose]);
      expect(f.state.input?.[1]).toBe("get");
      expect(f.state.input?.[2]).toEqual({ id: f.port.operationId });
      expect(result.operation.walletStarted).toBe(true);
      expect(result.executionAuthorization).toBe("NOT_ESTABLISHED");
      await expect(f.port.create(f.native, f.wire)).rejects.toThrow(
        "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
      );
      expect(f.state.journalCalls).toBe(1);
    },
  );
  it("recovers a lost create acknowledgement by reading the same operation identity", async () => {
    const f = fixture();
    f.state.loseCreateAck = true;
    await expect(f.port.create(f.native, f.wire)).rejects.toThrow(
      "RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST",
    );
    const result = await f.port.read();
    expect(f.state.purposes).toEqual(["prepare", "observe"]);
    expect(result.operation.id).toBe(f.native.operationId);
    expect(f.state.journalCalls).toBe(2);
  });
  it("rejects foreign task/phase/nonce context before any native request", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.task.digest = h("a");
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.scope.phase = "funded";
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.scope.nonce = "9007199254740992";
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(f.port.read()).rejects.toThrow();
      expect(f.state.journalCalls).toBe(0);
    }
  });
  it("rechecks the context after the await and withholds rows after a stop or context change", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.state.stopped = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.snapshot.scope.journalBindingHash = h("a");
      },
    ]) {
      const f = fixture();
      f.state.afterJournal = () => mutate(f);
      await expect(f.port.read()).rejects.toThrow();
      expect(f.state.journalCalls).toBe(1);
    }
  });
  it("checks the full native row digest, principal, wallet, chain, fields, revision and lifecycle", async () => {
    const mutations = [
      (r: ReceiptJournalOperation) => {
        r.requestHash = "0".repeat(64);
      },
      (r: ReceiptJournalOperation) => {
        r.wallet = a("c");
      },
      (r: ReceiptJournalOperation) => {
        r.chainId = 31337;
      },
      (r: ReceiptJournalOperation) => {
        r.revision = 0;
      },
      (r: ReceiptJournalOperation) => {
        r.status = "confirmed";
      },
      (r: ReceiptJournalOperation) => {
        r.transactionHash = h("f");
      },
      (r: ReceiptJournalOperation) => {
        r.plan.taskPrincipal.grantReference = "grant:foreign";
        r.requestHash = nftTaskJournalDigest(r.plan);
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f.state.row);
      await expect(f.port.read()).rejects.toThrow();
    }
    const f = fixture();
    Object.assign(f.state.row, { orderHash: h("f") });
    await expect(f.port.read()).rejects.toThrow();
  });
  it("rejects foreign approved business and an unexpected original native plan ID", async () => {
    const f = fixture();
    f.policy.intent.sale.price = "101";
    await expect(f.port.read()).rejects.toThrow();
    const other = fixture();
    other.state.row.plan.id = "another_native_plan_id";
    other.state.row.requestHash = nftTaskJournalDigest(other.state.row.plan);
    await expect(other.port.read("observe", other.native)).rejects.toThrow(
      "RECEIPT_JOURNAL_ROW_REFUSED",
    );
  });
  it("refuses invalid creation wire before a native write", async () => {
    const f = fixture();
    await expect(
      f.port.create(f.native, { ...f.wire, nonce: "3" }),
    ).rejects.toThrow();
    expect(f.state.journalCalls).toBe(0);
  });
  it("detaches the reviewed native plan and ephemeral wire before asynchronous context entry", async () => {
    const f = fixture();
    let release!: () => void, signal!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        signal = resolve;
      });
    f.state.beforeContext = async () => {
      signal();
      await pending;
    };
    const attempt = f.port.create(f.native, f.wire);
    await entered;
    f.native.wholeReceipt.sale.price = "999";
    f.wire.nonce = "9";
    release();
    const result = await attempt;
    expect(result.operation.plan.wholeReceipt.sale.price).toBe("100");
    expect(
      (f.state.input?.[2] as ReceiptJournalOperation).plan.wholeReceipt.sale
        .price,
    ).toBe("100");
  });
  it("refuses nested context, duplicate callbacks, unsupported purposes and missing configuration", async () => {
    const f = fixture();
    f.state.held = true;
    await expect(f.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_CONTEXT_REENTRY_REFUSED",
    );
    expect(f.state.journalCalls).toBe(0);
    const other = fixture();
    other.state.duplicate = true;
    await expect(other.port.read()).rejects.toThrow(
      "RECEIPT_JOURNAL_CONTEXT_REENTRY_REFUSED",
    );
    expect(other.state.journalCalls).toBe(1);
    await expect(other.port.read("prepare" as "observe")).rejects.toThrow();
    expect(() =>
      createWholeReceiptPreparedJournal({
        runtime: { ...other.runtime, authority: null },
        claimed: other.claimed,
        journal: other.journal,
      }),
    ).toThrow("RECEIPT_PREPARATION_NOT_CONFIGURED");
  });
});
