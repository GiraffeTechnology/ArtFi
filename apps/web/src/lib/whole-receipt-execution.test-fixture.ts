import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { createWholeReceiptApprovalCommitments } from "./whole-receipt-commitments";
import {
  createWholeReceiptExecutionComposition,
  type ReceiptExecutionCompositionOptions,
} from "./whole-receipt-execution-composition";
import { nftTaskJournalDigest } from "./nft/task-journal";
import type { ReceiptJournalOperation } from "./whole-receipt-prepared-journal";
import type {
  ReceiptProviderFactory,
  ReceiptActionRequest,
} from "./whole-receipt-held-action";
const h = (c: string) => `0x${c.repeat(64)}` as Hex;
const a = (c: string) => `0x${c.repeat(40)}` as Address;
const saleTuple =
  "(address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch)";
const correspondenceTuple =
  "(bytes32 settlementId,bytes32 assetRecordHash,bytes32 oracleSourceId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment,bytes32 oldCertificateHash,bytes32 warehouseReceiptHash)";
const abi = parseAbi([
  `function fund(${saleTuple} sale,${correspondenceTuple} correspondence,bytes signature)`,
  "function confirmRegistration(bytes32 id,bytes evidence)",
  "function paySeller(bytes32 id)",
]);
const evidence = parseAbiParameters(
  `${saleTuple} sale,${correspondenceTuple} correspondence,uint64 version,bytes proof`,
);
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

function businessFixture(phase: "funded" | "registered" | "paid" = "funded") {
  const taskPrincipal = {
    kind: "task" as const,
    taskId: "receipt-task",
    taskDigest: h("8"),
    executorDigest: h("9"),
    grantReference: "grant:example",
    grantPolicyVersion: "1",
    operationId: `receipt:${phase}`,
  };
  const { kind: _, ...binding } = taskPrincipal;
  const sale = {
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
  };
  const correspondence = {
    settlementId: h("1"),
    assetRecordHash: h("2"),
    oracleSourceId: h("3"),
    requestHash: h("4"),
    executionReferenceHash: h("5"),
    previousSegment: h("0"),
    oldCertificateHash: h("6"),
    warehouseReceiptHash: h("7"),
  };
  const native = {
    id: "plan_receipt_example_0001",
    operationId: `native_${kernelRequestDigest(binding)}`,
    chainId: 560048 as const,
    taskPrincipal,
    request: { account: sale.buyer },
    kind: "transaction" as const,
    wholeReceipt: {
      schemaVersion: 1 as const,
      phase,
      segmentId:
        "0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9" as Hex,
      domain: { chainId: 560048 as const, verifyingContract: a("3") },
      sale,
      correspondence,
      ...(phase === "registered"
        ? { kitRegistration: { version: "2", proofHash: keccak256("0x1234") } }
        : {}),
    },
  };
  const policy = {
    schema: "8415-agent-task/1",
    taskId: "receipt-task",
    tenant: "artfi",
    origin: "https://artfi.example:9445",
    chainId: "560048",
    actor: sale.buyer,
    expiresAt: "2000000000",
    fees: { perOperationWei: "1000000", totalWei: "3000000" },
    intent: {
      kind: "artfi-receipt",
      handlerId: "artfi:whole-receipt:v1",
      escrow: a("3"),
      runtimeCodeHash: h("a"),
      segmentId: native.wholeReceipt.segmentId,
      sale: { ...sale, startsAt: "1000", endsAt: "2000" },
      correspondence: structuredClone(correspondence),
      phases: [
        {
          phase,
          nonce: "9007199254740991",
          calldataHash: h("f"),
          planDigest: String(h("c")),
          journalBindingHash: String(h("d")),
          gasLimit: "21000",
          maxFeePerGasWei: "2",
          maxPriorityFeePerGasWei: "1",
        },
      ],
      recovery: {
        funding: "once",
        payout: "once",
        unknownOutcome: "reconcile-only",
      },
    },
  };
  const wire = {
    account: sale.buyer,
    chainId: "560048",
    to: a("3"),
    data: "0x" as Hex,
    value: "0",
    nonce: "9007199254740991",
    gasLimit: "21000",
    maxFeePerGasWei: "2",
    maxPriorityFeePerGasWei: "1",
  };
  const f = { native, policy, wire };
  encode(f);
  return f;
}
type Fixture = ReturnType<typeof businessFixture>;
function trade(f: Fixture) {
  const s = f.native.wholeReceipt.sale;
  return {
    ...s,
    tokenId: BigInt(s.tokenId),
    price: BigInt(s.price),
    salt: BigInt(s.salt),
    epoch: BigInt(s.epoch),
  };
}
function encode(
  f: Fixture,
  innerSale = trade(f),
  innerCorrespondence = f.native.wholeReceipt.correspondence,
  version = 2n,
  proof: Hex = "0x1234",
) {
  const r = f.native.wholeReceipt;
  f.wire.data =
    r.phase === "funded"
      ? encodeFunctionData({
          abi,
          functionName: "fund",
          args: [innerSale, innerCorrespondence, "0x1234"],
        })
      : r.phase === "paid"
        ? encodeFunctionData({
            abi,
            functionName: "paySeller",
            args: [r.segmentId],
          })
        : encodeFunctionData({
            abi,
            functionName: "confirmRegistration",
            args: [
              r.segmentId,
              encodeAbiParameters(evidence, [
                innerSale,
                innerCorrespondence,
                version,
                proof,
              ]),
            ],
          });
  f.policy.intent.phases[0]!.calldataHash = keccak256(f.wire.data);
}

/** TEST_ONLY structural Wallet/mTLS/DB adapters. Real product composition modules
 * run unchanged; these adapters do not verify a grant, real peer or persistence. */
export function createExecutionFixture(
  phase: "funded" | "registered" | "paid" = "paid",
) {
  const f = businessFixture(phase),
    principal = f.native.taskPrincipal;
  f.policy.expiresAt = "10";
  const approval = createWholeReceiptApprovalCommitments(
    {
      kind: f.native.kind,
      chainId: f.native.chainId,
      request: f.native.request,
      wholeReceipt: f.native.wholeReceipt,
    },
    {
      tenant: f.policy.tenant,
      origin: f.policy.origin,
      taskId: principal.taskId,
      actor: f.policy.actor,
      escrow: f.policy.intent.escrow,
      runtimeCodeHash: f.policy.intent.runtimeCodeHash,
    },
  );
  const slot = f.policy.intent.phases[0]!;
  slot.planDigest = approval.receiptPlanDigest;
  slot.journalBindingHash = approval.receiptJournalBindingHash;
  const { kind: _, ...binding } = principal;
  const claimed = {
    ...binding,
    phase,
    planDigest: slot.planDigest,
    journalBindingHash: slot.journalBindingHash,
  };
  const task = { policy: f.policy, digest: principal.taskDigest };
  const snapshot = {
    task,
    executor: { digest: principal.executorDigest },
    expiresAtMs: 10000,
    scope: {
      ...slot,
      actor: f.policy.actor,
      chainId: f.policy.chainId,
      escrow: f.policy.intent.escrow,
      runtimeCodeHash: f.policy.intent.runtimeCodeHash,
      segmentId: f.native.wholeReceipt.segmentId,
    },
  };
  const row: ReceiptJournalOperation = {
    id: f.native.operationId,
    wallet: f.native.request.account,
    chainId: f.native.chainId,
    requestHash: nftTaskJournalDigest(f.native),
    revision: 1,
    status: "awaiting-wallet",
    walletStarted: false,
    plan: structuredClone(f.native),
    updatedAt: "2026-10-22T00:00:00Z",
  };
  const state = {
    held: false,
    now: 1000,
    revoked: false,
    consumed: false,
    gates: 0,
    sendCalls: 0,
    actor: f.native.request.account,
    providerUnknown: false,
    zeroHash: false,
    gateAckUnknown: false,
    failCAS: false,
    loseCASAck: false,
    loseSubmissionAck: false,
    rejectSubmission: false,
    trace: [] as string[],
    bodies: [] as string[],
    scopes: [] as unknown[],
    row: structuredClone(row),
    submitted: undefined as Hex | undefined,
    beforeRead: undefined as undefined | (() => Promise<void>),
    afterCAS: undefined as undefined | (() => void),
    sendWait: undefined as undefined | (() => Promise<void>),
  };
  const recheck = () => {
    if (!state.held || state.revoked) throw Error("TEST_ONLY_RUNTIME_INACTIVE");
  };
  const runtime: ReceiptExecutionCompositionOptions["runtime"] = {
    state: "configured",
    inHeldGate: () => state.held,
    authority: {
      async withPreparation(_claim, purpose, callback) {
        if (state.held) throw Error("TEST_ONLY_NESTED_GATE");
        if (purpose === "prepare" && (state.revoked || state.now >= 10000))
          throw Error("TEST_ONLY_INACTIVE");
        state.held = true;
        state.trace.push("prepare:" + purpose);
        try {
          return await callback(snapshot, () => {
            if (!state.held) throw Error("TEST_ONLY_NOT_HELD");
          });
        } finally {
          state.held = false;
        }
      },
      async withAuthorization(_claim, _wire, callback) {
        if (state.held || state.consumed || state.revoked || state.now >= 10000)
          throw Error("TEST_ONLY_AUTHORIZATION_REFUSED");
        state.consumed = true;
        state.held = true;
        state.gates++;
        state.trace.push("authorize");
        let hash: Hex;
        try {
          hash = await callback(snapshot, recheck);
        } finally {
          state.held = false;
          state.trace.push("release");
        }
        state.submitted = hash;
        if (state.gateAckUnknown) throw Error("TEST_ONLY_WALLET_ACK_UNKNOWN");
        return { transactionHash: hash };
      },
    },
  };
  const factory: ReceiptProviderFactory = ({ authorization, claimed }) => ({
    async identity() {
      return { account: state.actor, chainId: 560048 };
    },
    async sendTransaction(input) {
      const result = await authorization.withAuthorization(
        claimed,
        {
          ...f.wire,
          account: input.account,
          to: input.to,
          data: input.data,
          value: "0",
          chainId: String(input.chainId),
        },
        async () => {
          state.trace.push("send");
          state.sendCalls++;
          await state.sendWait?.();
          if (state.providerUnknown)
            throw Error("TEST_ONLY_PROVIDER_UNKNOWN_DO_NOT_EXPOSE");
          return state.zeroHash ? h("0") : h("f");
        },
      );
      return result.transactionHash as Hex;
    },
  });
  const journalConfig: ReceiptExecutionCompositionOptions["journalConfig"] = {
    url: "https://journal.invalid/internal/v1/nft/operations",
    peerId: "spiffe://test.invalid/artfi",
    async withCapability(scope, consumeCapability) {
      if (!state.held) throw Error("TEST_ONLY_CAPABILITY_OUTSIDE_GATE");
      state.scopes.push(structuredClone(scope));
      return consumeCapability(
        "TEST_ONLY_EPHEMERAL_CAPABILITY_00000000000000000000",
      );
    },
    async transport(_url, init) {
      if (!state.held) throw Error("TEST_ONLY_TRANSPORT_OUTSIDE_GATE");
      const body = String(init.body);
      state.bodies.push(body);
      const { action, operation } = JSON.parse(body);
      state.trace.push("journal:" + action);
      if (action === "get") {
        await state.beforeRead?.();
        return Response.json(state.row);
      }
      if (action === "create") return Response.json(state.row);
      if (
        action !== "update" ||
        operation.revision !== state.row.revision ||
        state.failCAS
      )
        return new Response(null, { status: 409 });
      if (operation.transactionHash && state.rejectSubmission)
        return new Response(null, { status: 503 });
      state.row = {
        ...structuredClone(operation),
        revision: operation.revision + 1,
        updatedAt: "2026-10-22T00:00:01Z",
      };
      if (operation.transactionHash) {
        if (state.loseSubmissionAck) throw Error("TEST_ONLY_ACK_UNKNOWN");
      } else {
        state.trace.push("cas-started");
        state.afterCAS?.();
        if (state.loseCASAck) throw Error("TEST_ONLY_CAS_UNKNOWN");
      }
      return Response.json(state.row);
    },
  };
  const request: ReceiptActionRequest = {
    account: f.wire.account,
    chainId: 560048,
    to: f.wire.to,
    data: f.wire.data,
    value: 0n,
  };
  const options: ReceiptExecutionCompositionOptions = {
    runtime,
    createProviderHandler: factory,
    provider: {
      async request() {
        throw Error("TEST_ONLY_NO_DIRECT_RPC");
      },
    },
    task,
    claimed,
    journalConfig,
    now: () => state.now,
  };
  return {
    ...f,
    state,
    options,
    request,
    principal,
    claimed,
    create: () => createWholeReceiptExecutionComposition(options),
  };
}
