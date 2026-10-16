import "server-only";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { nftTaskJournalDigest } from "./nft/task-journal";
import {
  matchWholeReceiptBusiness,
  projectWholeReceiptBusiness,
} from "./whole-receipt-business";

type Plan = ReturnType<typeof projectWholeReceiptBusiness>["nativePlan"];
type Principal = Plan["taskPrincipal"];
type Claim = Omit<Principal, "kind"> & {
  phase: "funded" | "registered" | "paid";
  planDigest: string;
  journalBindingHash: string;
};
type Purpose = "prepare" | "review" | "observe";
type Snapshot = {
  task: { policy: unknown; digest: string };
  executor: { digest: string };
  expiresAtMs: number;
  scope: {
    phase: string;
    nonce: string;
    planDigest: string;
    journalBindingHash: string;
    actor: string;
    chainId: string;
    escrow: string;
    runtimeCodeHash: string;
    segmentId: string;
  };
};
export type ReceiptPreparationRuntime = {
  state: string;
  inHeldGate(): boolean;
  authority: null | {
    withPreparation<T>(
      claimed: Claim,
      purpose: Purpose,
      action: (snapshot: Snapshot, recheck: () => void) => Promise<T>,
    ): Promise<T>;
  };
};
export type ReceiptJournalOperation = {
  id: string;
  wallet: string;
  chainId: number;
  requestHash: string;
  revision: number;
  status: string;
  walletStarted: boolean;
  plan: Plan;
  transactionHash?: string;
  updatedAt: string;
};
/** Bind the existing authenticated task-journal implementation at installation.
 * This function carries the entire unsigned operation; no receipt fields may be
 * removed and no session/bearer-only or in-memory fallback is supplied here. */
export type ReceiptNativeJournal = (
  principal: Principal,
  action: "get" | "create",
  operation: { id: string } | ReceiptJournalOperation,
) => Promise<unknown>;
export class ReceiptJournalContextError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReceiptJournalContextError";
  }
}
const principalKeys = [
  "kind",
  "taskId",
  "taskDigest",
  "executorDigest",
  "grantReference",
  "grantPolicyVersion",
  "operationId",
];
const claimKeys = [
  ...principalKeys.filter((k) => k !== "kind"),
  "phase",
  "planDigest",
  "journalBindingHash",
];
const correspondenceKeys = [
  "settlementId",
  "assetRecordHash",
  "oracleSourceId",
  "requestHash",
  "executionReferenceHash",
  "previousSegment",
  "oldCertificateHash",
  "warehouseReceiptHash",
];
const wireKeys = [
  "account",
  "chainId",
  "to",
  "data",
  "value",
  "nonce",
  "gasLimit",
  "maxFeePerGasWei",
  "maxPriorityFeePerGasWei",
];
function fail(code = "RECEIPT_JOURNAL_BINDING_REFUSED"): never {
  throw new ReceiptJournalContextError(code);
}
function fields(
  raw: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    fail();
  const d = Object.getOwnPropertyDescriptors(raw),
    keys = Reflect.ownKeys(d);
  if (
    required.some((k) => !Object.hasOwn(d, k)) ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        ![...required, ...optional].includes(k) ||
        !d[k]!.enumerable ||
        !Object.hasOwn(d[k]!, "value"),
    )
  )
    fail();
  return Object.fromEntries(
    keys.map((k) => [k, d[k as string]!.value]),
  ) as Record<string, unknown>;
}
const same = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const hash = (x: unknown) =>
  typeof x === "string" && /^0x[a-f0-9]{64}$/.test(x) && !/^0x0{64}$/.test(x);
const decimal = (x: unknown): x is string =>
  typeof x === "string" &&
  /^(0|[1-9][0-9]{0,77})$/.test(x) &&
  BigInt(x) < 1n << 256n;
function clone<T>(value: T): T {
  return structuredClone(value);
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const statuses = new Set([
  "awaiting-wallet",
  "submitted",
  "pending",
  "accepted",
  "cancelled",
  "rejected",
  "failed",
  "confirmed",
]);

export function createWholeReceiptPreparedJournal(options: {
  runtime: ReceiptPreparationRuntime;
  claimed: Claim;
  journal: ReceiptNativeJournal;
  now?: () => number;
}) {
  const { runtime } = options,
    now = options.now ?? Date.now;
  if (
    runtime?.state !== "configured" ||
    typeof runtime.inHeldGate !== "function" ||
    typeof runtime.authority?.withPreparation !== "function" ||
    typeof options.journal !== "function" ||
    typeof now !== "function"
  )
    fail("RECEIPT_PREPARATION_NOT_CONFIGURED");
  const raw = fields(options.claimed, claimKeys);
  if (
    claimKeys.some((k) => typeof raw[k] !== "string") ||
    !["taskId", "operationId"].every((k) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw[k] as string),
    ) ||
    !["taskDigest", "executorDigest", "planDigest", "journalBindingHash"].every(
      (k) => hash(raw[k]),
    ) ||
    !/^grant:[A-Za-z0-9_-]{1,122}$/.test(raw.grantReference as string) ||
    !decimal(raw.grantPolicyVersion) ||
    raw.grantPolicyVersion === "0" ||
    !["funded", "registered", "paid"].includes(raw.phase as string)
  )
    fail();
  const claimed = Object.freeze(raw as Claim);
  const principal = Object.freeze(
    Object.fromEntries(
      principalKeys.map((k) => [
        k,
        k === "kind" ? "task" : claimed[k as keyof Claim],
      ]),
    ) as Principal,
  );
  const { kind: _, ...binding } = principal;
  const operationId = `native_${kernelRequestDigest(binding)}`;
  const prepare = runtime.authority.withPreparation.bind(runtime.authority);
  const inHeldGate = runtime.inHeldGate.bind(runtime);
  const journal = options.journal;
  let running = false;

  function snapshotClaim(snapshot: Snapshot) {
    if (
      snapshot?.task?.digest !== claimed.taskDigest ||
      snapshot?.executor?.digest !== claimed.executorDigest ||
      snapshot?.scope?.phase !== claimed.phase ||
      snapshot.scope.planDigest !== claimed.planDigest ||
      snapshot.scope.journalBindingHash !== claimed.journalBindingHash ||
      !decimal(snapshot.scope.nonce) ||
      BigInt(snapshot.scope.nonce) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail();
  }

  function identity(p: Plan) {
    if (
      p.operationId !== operationId ||
      p.wholeReceipt.phase !== claimed.phase ||
      principalKeys.some(
        (k) =>
          p.taskPrincipal[k as keyof Principal] !==
          principal[k as keyof Principal],
      )
    )
      fail();
  }
  /** The real runtime has validated/frozen this policy. Compare the full stored
   * business projection, not a caller's assertion that a hash was approved. */
  function bound(p: Plan, snapshot: Snapshot) {
    identity(p);
    const policy = fields(snapshot.task.policy, [
      "schema",
      "taskId",
      "tenant",
      "origin",
      "chainId",
      "actor",
      "expiresAt",
      "fees",
      "intent",
    ]);
    const intent = fields(policy.intent, [
      "kind",
      "handlerId",
      "escrow",
      "runtimeCodeHash",
      "segmentId",
      "sale",
      "correspondence",
      "phases",
      "recovery",
    ]);
    const sale = fields(intent.sale, [
      "seller",
      "collection",
      "tokenId",
      "paymentToken",
      "price",
      "buyer",
      "salt",
      "startsAt",
      "endsAt",
      "epoch",
    ]);
    const correspondence = fields(intent.correspondence, correspondenceKeys),
      r = p.wholeReceipt,
      scope = snapshot.scope;
    if (
      snapshot.task.digest !== principal.taskDigest ||
      snapshot.executor.digest !== principal.executorDigest ||
      policy.schema !== "8415-agent-task/1" ||
      policy.taskId !== principal.taskId ||
      policy.chainId !== String(p.chainId) ||
      !same(policy.actor, p.request.account) ||
      intent.kind !== "artfi-receipt" ||
      intent.handlerId !== "artfi:whole-receipt:v1" ||
      !same(intent.escrow, r.domain.verifyingContract) ||
      !same(intent.segmentId, r.segmentId) ||
      scope.phase !== claimed.phase ||
      scope.planDigest !== claimed.planDigest ||
      scope.journalBindingHash !== claimed.journalBindingHash ||
      !decimal(scope.nonce) ||
      BigInt(scope.nonce) > BigInt(Number.MAX_SAFE_INTEGER) ||
      scope.chainId !== policy.chainId ||
      !same(scope.actor, policy.actor) ||
      !same(scope.escrow, intent.escrow) ||
      !same(scope.segmentId, intent.segmentId) ||
      !hash(scope.runtimeCodeHash) ||
      scope.runtimeCodeHash !== intent.runtimeCodeHash ||
      !decimal(policy.expiresAt) ||
      policy.expiresAt === "0" ||
      !Number.isSafeInteger(snapshot.expiresAtMs) ||
      snapshot.expiresAtMs !== Number(BigInt(policy.expiresAt) * 1000n)
    )
      fail();
    for (const k of ["seller", "collection", "paymentToken", "buyer"] as const)
      if (!same(sale[k], r.sale[k])) fail();
    for (const k of ["tokenId", "price", "salt", "epoch"] as const)
      if (sale[k] !== r.sale[k]) fail();
    if (
      sale.startsAt !== String(r.sale.startsAt) ||
      sale.endsAt !== String(r.sale.endsAt)
    )
      fail();
    for (const k of correspondenceKeys)
      if (
        !same(
          correspondence[k],
          r.correspondence[k as keyof typeof r.correspondence],
        )
      )
        fail();
    if (!Array.isArray(intent.phases)) fail();
    const matching = intent.phases.filter((s) => s?.phase === claimed.phase);
    if (
      matching.length !== 1 ||
      matching[0].nonce !== scope.nonce ||
      matching[0].planDigest !== claimed.planDigest ||
      matching[0].journalBindingHash !== claimed.journalBindingHash
    )
      fail();
  }
  function readRow(
    rawRow: unknown,
    snapshot: Snapshot,
    expected?: Plan,
  ): ReceiptJournalOperation {
    const row = fields(
      rawRow,
      [
        "id",
        "wallet",
        "chainId",
        "requestHash",
        "revision",
        "status",
        "walletStarted",
        "plan",
        "updatedAt",
      ],
      ["transactionHash"],
    );
    let p: Plan;
    try {
      p = projectWholeReceiptBusiness(row.plan).nativePlan;
    } catch {
      fail("RECEIPT_JOURNAL_ROW_REFUSED");
    }
    bound(p, snapshot);
    if (
      row.id !== operationId ||
      row.id !== p.operationId ||
      row.chainId !== p.chainId ||
      !same(row.wallet, p.request.account) ||
      row.requestHash !== nftTaskJournalDigest(p) ||
      !Number.isSafeInteger(row.revision) ||
      (row.revision as number) < 1 ||
      typeof row.status !== "string" ||
      !statuses.has(row.status) ||
      typeof row.walletStarted !== "boolean" ||
      typeof row.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      (row.transactionHash !== undefined &&
        (typeof row.transactionHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(row.transactionHash) ||
          /^0x0{64}$/i.test(row.transactionHash) ||
          !row.walletStarted)) ||
      (["pending", "submitted", "confirmed"].includes(row.status) &&
        (!row.walletStarted || !row.transactionHash)) ||
      (row.status === "awaiting-wallet" && row.transactionHash !== undefined) ||
      (expected && nftTaskJournalDigest(p) !== nftTaskJournalDigest(expected))
    )
      fail("RECEIPT_JOURNAL_ROW_REFUSED");
    return freeze({
      ...row,
      plan: p,
    } as ReceiptJournalOperation) as ReceiptJournalOperation;
  }
  async function context<T>(
    purpose: Purpose,
    action: (snapshot: Snapshot, active: () => void) => Promise<T>,
  ) {
    if (running || inHeldGate())
      fail("RECEIPT_JOURNAL_CONTEXT_REENTRY_REFUSED");
    running = true;
    let entered = false,
      live = false;
    try {
      return await prepare(claimed, purpose, async (snapshot, recheck) => {
        if (entered) fail("RECEIPT_JOURNAL_CONTEXT_REENTRY_REFUSED");
        entered = true;
        live = true;
        const active = () => {
          recheck();
          const time = now();
          if (
            !live ||
            !inHeldGate() ||
            !Number.isSafeInteger(time) ||
            time < 0 ||
            (purpose === "prepare" && time >= snapshot.expiresAtMs)
          )
            fail("RECEIPT_JOURNAL_CONTEXT_EXPIRED");
        };
        try {
          active();
          snapshotClaim(snapshot);
          const result = await action(snapshot, active);
          active();
          snapshotClaim(snapshot);
          return result;
        } finally {
          live = false;
        }
      }).then((result) => {
        if (!entered) fail("RECEIPT_JOURNAL_CONTEXT_NOT_ENTERED");
        return result;
      });
    } catch (error) {
      if (error instanceof ReceiptJournalContextError) throw error;
      // The native write may have committed. Recover this same operation via
      // read; never create a fresh identity or re-open send authority here.
      fail("RECEIPT_JOURNAL_OUTCOME_UNKNOWN_READ_FIRST");
    } finally {
      running = false;
      live = false;
    }
  }
  const response = (operation: ReceiptJournalOperation) =>
    freeze({
      operation,
      executionAuthorization: "NOT_ESTABLISHED" as const,
      approvalCommitments: "NOT_RECOMPUTED" as const,
    });
  return Object.freeze({
    operationId,
    /** Recovery is available under the original grant policy version, including
     * after expiry/revocation as permitted by the actual Wallet source. */
    async read(
      purpose: "review" | "observe" = "observe",
      expectedPlan?: unknown,
    ) {
      if (!["review", "observe"].includes(purpose)) fail();
      let expected: Plan | undefined;
      if (expectedPlan !== undefined) {
        expected = projectWholeReceiptBusiness(expectedPlan).nativePlan;
        identity(expected);
      }
      return context(purpose, async (snapshot, active) => {
        const row = await journal(
          principal,
          "get",
          Object.freeze({ id: operationId }),
        );
        active();
        return response(readRow(row, snapshot, expected));
      });
    },
    /** The exact ephemeral wire proves phase/calldata/proof equality, but is
     * never sent to the native journal or retained in the returned operation. */
    async create(rawPlan: unknown, rawWire: unknown) {
      const p = projectWholeReceiptBusiness(rawPlan).nativePlan;
      identity(p);
      const wire = Object.freeze(fields(rawWire, wireKeys));
      return context("prepare", async (snapshot, active) => {
        bound(p, snapshot);
        matchWholeReceiptBusiness(p, snapshot.task.policy, wire);
        active();
        const operation: ReceiptJournalOperation = {
          id: operationId,
          wallet: p.request.account,
          chainId: p.chainId,
          requestHash: nftTaskJournalDigest(p),
          revision: 0,
          status: "awaiting-wallet",
          walletStarted: false,
          plan: p,
          updatedAt: "",
        };
        const row = await journal(principal, "create", clone(operation));
        active();
        // Exact idempotent create may return a progressed row. Preserve its
        // status/marker/hash/revision; do not replace them with initial values.
        return response(readRow(row, snapshot, p));
      });
    },
  });
}
