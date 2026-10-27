import { describe, expect, it, vi } from "vitest";
import { createWholeReceiptApprovalCommitments } from "./whole-receipt-commitments";
import { encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import {
  createWholeReceiptHeldAction,
  type ReceiptActionRequest,
  type ReceiptHeldLease,
  type ReceiptHeldRuntime,
  type ReceiptProviderFactory,
} from "./whole-receipt-held-action";
vi.mock("server-only", () => ({}));
const h = (c: string) => `0x${c.repeat(64)}` as Hex;
const a = (c: string) => `0x${c.repeat(40)}`;
const abi = parseAbi(["function paySeller(bytes32 id)"]);

/** Synthetic gate/factory in the exact pinned public method shape. These tests
 * do not authenticate a Wallet grant, mTLS peer, native DB or provider. */
function fixture() {
  const state = {
    held: false,
    now: 1000,
    gates: 0,
    providerCalls: 0,
    identities: 0,
    submitted: undefined as Hex | undefined,
    trace: [] as string[],
    failProvider: false,
    gateAckFails: false,
    observedActor: a("b"),
    repeatedCallback: false,
    providerWait: undefined as undefined | (() => Promise<void>),
    beforeGateCallback: undefined as undefined | (() => void),
  };
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
  const segmentId =
    "0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9" as Hex;
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
      segmentId,
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
  const request: ReceiptActionRequest = {
    account: a("b"),
    chainId: 560048,
    to: a("3"),
    data: encodeFunctionData({
      abi,
      functionName: "paySeller",
      args: [segmentId],
    }),
    value: 0n,
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
    phase: "paid" as const,
    nonce: "2",
    calldataHash: keccak256(request.data),
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
    taskId: principal.taskId,
    tenant: "artfi",
    origin: "https://artfi.example:9445",
    chainId: "560048",
    actor: a("b"),
    expiresAt: "2000000000",
    fees: { perOperationWei: "100000", totalWei: "100000" },
    intent: {
      kind: "artfi-receipt",
      handlerId: "artfi:whole-receipt:v1",
      escrow: a("3"),
      runtimeCodeHash: h("e"),
      segmentId,
      sale: { ...native.wholeReceipt.sale, startsAt: "1000", endsAt: "2000" },
      correspondence: native.wholeReceipt.correspondence,
      phases: [slot],
      recovery: {
        funding: "once",
        payout: "once",
        unknownOutcome: "reconcile-only",
      },
    },
  };
  const task = { policy, digest: principal.taskDigest };
  const snapshot = {
    task,
    executor: { digest: principal.executorDigest },
    scope: {
      phase: "paid",
      nonce: slot.nonce,
      planDigest: slot.planDigest,
      journalBindingHash: slot.journalBindingHash,
    },
    expiresAtMs: 10000,
  };
  const runtime: ReceiptHeldRuntime = {
    state: "configured",
    inHeldGate: () => state.held,
    authority: {
      async withAuthorization(_claimed, _wire, callback) {
        if (state.held) throw Error("SYNTHETIC_GATE_REENTRY");
        state.gates++;
        state.trace.push("reserve");
        state.held = true;
        let hash: Hex;
        try {
          state.beforeGateCallback?.();
          hash = await callback(snapshot, () => {
            if (!state.held) throw Error("SYNTHETIC_NOT_HELD");
          });
          if (state.repeatedCallback) await callback(snapshot, () => {});
        } finally {
          state.held = false;
          state.trace.push("release");
        }
        state.submitted = hash;
        state.trace.push("record-wallet-attempt");
        if (state.gateAckFails) throw Error("SYNTHETIC_WALLET_ACK_UNKNOWN");
        return { transactionHash: hash };
      },
    },
  };
  const factory: ReceiptProviderFactory = ({
    authorization,
    claimed: fixedClaimed,
  }) => ({
    async identity() {
      state.identities++;
      return { account: state.observedActor, chainId: 560048 };
    },
    async sendTransaction(input) {
      const wire = {
        account: input.account,
        chainId: String(input.chainId),
        to: input.to,
        data: input.data,
        value: "0" as const,
        nonce: slot.nonce,
        gasLimit: slot.gasLimit,
        maxFeePerGasWei: slot.maxFeePerGasWei,
        maxPriorityFeePerGasWei: slot.maxPriorityFeePerGasWei,
      };
      const result = await authorization.withAuthorization(
        fixedClaimed,
        wire,
        async () => {
          state.providerCalls++;
          state.trace.push("provider-send");
          await state.providerWait?.();
          if (state.failProvider) throw Error("SYNTHETIC_PROVIDER_UNKNOWN");
          return h("f");
        },
      );
      return result.transactionHash as Hex;
    },
  });
  const provider = {
    request: async () => {
      throw Error("UNEXPECTED_DIRECT_PROVIDER_CALL");
    },
  };
  const options = {
    runtime,
    createProviderHandler: factory,
    provider,
    task,
    claimed,
    now: () => state.now,
  };
  return {
    state,
    native,
    principal,
    request,
    slot,
    policy,
    snapshot,
    runtime,
    factory,
    options,
  };
}

describe("ArtFi single held receipt action composition", () => {
  it("refuses a coherent but opaque legacy slot before reserving or invoking the action", async () => {
    const f = fixture();
    Object.assign(f.slot, { planDigest: h("c"), journalBindingHash: h("d") });
    Object.assign(f.options.claimed, {
      planDigest: h("c"),
      journalBindingHash: h("d"),
    });
    Object.assign(f.snapshot.scope, {
      planDigest: h("c"),
      journalBindingHash: h("d"),
    });
    const action = vi.fn(async () => undefined);
    await expect(
      createWholeReceiptHeldAction(f.options).authorize(
        f.principal,
        f.native,
        action,
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_APPROVAL_COMMITMENT_REFUSED");
    expect(f.state.gates).toBe(0);
    expect(f.state.providerCalls).toBe(0);
    expect(action).not.toHaveBeenCalled();
  });
  it.each(["tenant", "origin", "runtimeCodeHash"] as const)(
    "refuses stale installation %s content before gate reservation",
    async (key) => {
      const f = fixture();
      if (key === "runtimeCodeHash") f.policy.intent.runtimeCodeHash = h("6");
      else
        f.policy[key] =
          key === "tenant" ? "another-artfi" : "https://another.example:9445";
      const action = vi.fn(async () => undefined);
      await expect(
        createWholeReceiptHeldAction(f.options).authorize(
          f.principal,
          f.native,
          action,
          f.request,
        ),
      ).rejects.toThrow("RECEIPT_APPROVAL_COMMITMENT_REFUSED");
      expect(f.state.gates).toBe(0);
      expect(f.state.providerCalls).toBe(0);
      expect(action).not.toHaveBeenCalled();
    },
  );
  it("compares the genuine held snapshot after pre-reservation validation", async () => {
    const f = fixture();
    f.state.beforeGateCallback = () => {
      f.snapshot.task.policy.origin = "https://changed.example:9445";
    };
    const action = vi.fn(async () => undefined);
    await expect(
      createWholeReceiptHeldAction(f.options).authorize(
        f.principal,
        f.native,
        action,
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_APPROVAL_COMMITMENT_REFUSED");
    expect(f.state.gates).toBe(1);
    expect(f.state.providerCalls).toBe(0);
    expect(f.state.held).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
  it("refuses a claimed content digest that differs from the approved slot", async () => {
    const f = fixture();
    f.options.claimed.planDigest = h("c");
    const action = vi.fn(async () => undefined);
    await expect(
      createWholeReceiptHeldAction(f.options).authorize(
        f.principal,
        f.native,
        action,
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_APPROVAL_COMMITMENT_REFUSED");
    expect(f.state.gates).toBe(0);
    expect(f.state.providerCalls).toBe(0);
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps the existing journal/CAS callback before the one provider call inside one gate", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    const result = await port.authorize(
      f.principal,
      f.native,
      async (lease) => {
        expect(f.runtime.inHeldGate()).toBe(true);
        expect(await lease.wallet.identity()).toEqual({
          account: a("b"),
          chainId: 560048,
        });
        f.state.trace.push("native-journal-cas");
        const transactionHash = await lease.wallet.sendTransaction(f.request);
        f.state.trace.push("native-record-submission");
        return { status: "pending", transactionHash };
      },
      f.request,
    );
    expect(result).toEqual({ status: "pending", transactionHash: h("f") });
    expect(f.state.trace).toEqual([
      "reserve",
      "native-journal-cas",
      "provider-send",
      "native-record-submission",
      "release",
      "record-wallet-attempt",
    ]);
    expect(f.state.gates).toBe(1);
    expect(f.state.providerCalls).toBe(1);
  });
  it("does not dispatch when the native consumer/CAS refuses", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        async () => {
          throw Error("SYNTHETIC_NATIVE_RECEIPT_503");
        },
        f.request,
      ),
    ).rejects.toThrow("SYNTHETIC_NATIVE_RECEIPT_503");
    expect(f.state.gates).toBe(1);
    expect(f.state.providerCalls).toBe(0);
    await expect(
      port.authorize(f.principal, f.native, async () => undefined, f.request),
    ).rejects.toThrow("RECEIPT_GATE_REENTRY_REFUSED");
  });
  it("keeps a known hash in the real authority result before propagating journal acknowledgement failure", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        async (lease) => {
          await lease.wallet.sendTransaction(f.request);
          throw Error("SYNTHETIC_NATIVE_ACK_UNKNOWN");
        },
        f.request,
      ),
    ).rejects.toThrow("SYNTHETIC_NATIVE_ACK_UNKNOWN");
    expect(f.state.submitted).toBe(h("f"));
    expect(f.state.providerCalls).toBe(1);
  });
  it("never replays an unknown provider outcome, even if the callback tries to retry", async () => {
    const f = fixture();
    f.state.failProvider = true;
    const port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        async (lease) => {
          await expect(lease.wallet.sendTransaction(f.request)).rejects.toThrow(
            "SYNTHETIC_PROVIDER_UNKNOWN",
          );
          return lease.wallet.sendTransaction(f.request);
        },
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_PROVIDER_ALREADY_DISPATCHED");
    expect(f.state.providerCalls).toBe(1);
    expect(f.state.submitted).toBeUndefined();
  });
  it("does not return a native success if Wallet persistence acknowledgement is unknown", async () => {
    const f = fixture();
    f.state.gateAckFails = true;
    const port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        (lease) => lease.wallet.sendTransaction(f.request),
        f.request,
      ),
    ).rejects.toThrow("SYNTHETIC_WALLET_ACK_UNKNOWN");
    expect(f.state.providerCalls).toBe(1);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        (lease) => lease.wallet.sendTransaction(f.request),
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_GATE_REENTRY_REFUSED");
  });
  it("rejects a changed leased request before dispatch and rejects leases after callback completion", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    let saved: ReceiptHeldLease | undefined;
    await expect(
      port.authorize(
        f.principal,
        f.native,
        async (lease) => {
          saved = lease;
          return lease.wallet.sendTransaction({ ...f.request, to: a("4") });
        },
        f.request,
      ),
    ).rejects.toThrow();
    expect(f.state.providerCalls).toBe(0);
    await expect(saved!.wallet.sendTransaction(f.request)).rejects.toThrow(
      "RECEIPT_PROVIDER_ALREADY_DISPATCHED",
    );
    await expect(saved!.wallet.identity()).rejects.toThrow();
  });
  it("rechecks deadline and provider identity before a send", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        async (lease) => {
          f.state.now = f.snapshot.expiresAtMs;
          return lease.wallet.sendTransaction(f.request);
        },
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_HELD_LEASE_EXPIRED");
    expect(f.state.providerCalls).toBe(0);
    const other = fixture(),
      otherPort = createWholeReceiptHeldAction(other.options);
    await expect(
      otherPort.authorize(
        other.principal,
        other.native,
        async (lease) => {
          other.state.observedActor = a("c");
          await lease.wallet.identity();
          return lease.wallet.sendTransaction(other.request);
        },
        other.request,
      ),
    ).rejects.toThrow();
    expect(other.state.providerCalls).toBe(0);
  });
  it("rejects foreign native principal and invalid business before gate reservation", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        { ...f.principal, operationId: "foreign" },
        f.native,
        async () => undefined,
        f.request,
      ),
    ).rejects.toThrow();
    f.policy.intent.sale.price = "101";
    await expect(
      port.authorize(f.principal, f.native, async () => undefined, f.request),
    ).rejects.toThrow();
    expect(f.state.gates).toBe(0);
    expect(f.state.providerCalls).toBe(0);
  });
  it("refuses callback duplication and nested authorization instead of opening a second gate", async () => {
    const f = fixture();
    f.state.repeatedCallback = true;
    const port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(
        f.principal,
        f.native,
        (lease) => lease.wallet.sendTransaction(f.request),
        f.request,
      ),
    ).rejects.toThrow("RECEIPT_CALLBACK_ALREADY_ENTERED");
    expect(f.state.providerCalls).toBe(1);
    expect(f.state.gates).toBe(1);
    const other = fixture(),
      next = createWholeReceiptHeldAction(other.options);
    await expect(
      next.authorize(
        other.principal,
        other.native,
        async () =>
          next.authorize(
            other.principal,
            other.native,
            async () => undefined,
            other.request,
          ),
        other.request,
      ),
    ).rejects.toThrow("RECEIPT_GATE_REENTRY_REFUSED");
    expect(other.state.gates).toBe(1);
    expect(other.state.providerCalls).toBe(0);
  });
  it("does not claim dispatch when the action returns without using its lease", async () => {
    const f = fixture(),
      port = createWholeReceiptHeldAction(f.options);
    await expect(
      port.authorize(f.principal, f.native, async () => "not-sent", f.request),
    ).rejects.toThrow("RECEIPT_PROVIDER_NOT_DISPATCHED");
    expect(f.state.providerCalls).toBe(0);
    expect(f.state.submitted).toBeUndefined();
  });
  it("drains an already started dispatch before releasing the held gate after a callback failure", async () => {
    const f = fixture();
    let release!: () => void, notify!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    f.state.providerWait = async () => {
      notify();
      await pending;
    };
    const port = createWholeReceiptHeldAction(f.options);
    const attempt = port.authorize(
      f.principal,
      f.native,
      async (lease) => {
        void lease.wallet.sendTransaction(f.request).catch(() => {});
        throw Error("SYNTHETIC_CALLBACK_FAILED_WHILE_DISPATCHING");
      },
      f.request,
    );
    const failure = expect(attempt).rejects.toThrow(
      "SYNTHETIC_CALLBACK_FAILED_WHILE_DISPATCHING",
    );
    await started;
    expect(f.state.held).toBe(true);
    expect(f.state.submitted).toBeUndefined();
    release();
    await failure;
    expect(f.state.submitted).toBe(h("f"));
    expect(f.state.held).toBe(false);
    expect(f.state.providerCalls).toBe(1);
  });
});
