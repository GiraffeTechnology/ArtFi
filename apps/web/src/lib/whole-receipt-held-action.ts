import "server-only";
import type { Hex } from "viem";
import {
  matchWholeReceiptBusiness,
  projectWholeReceiptBusiness,
} from "./whole-receipt-business";

type NativePlan = ReturnType<typeof projectWholeReceiptBusiness>["nativePlan"];
type Principal = NativePlan["taskPrincipal"];
export type ReceiptActionRequest = Readonly<{
  account: string;
  chainId: number;
  to: string;
  data: Hex;
  value: 0n;
}>;
type ReceiptClaim = Omit<Principal, "kind"> & {
  phase: "funded" | "registered" | "paid";
  planDigest: string;
  journalBindingHash: string;
};
type ReceiptTask = Readonly<{ policy: unknown; digest: string }>;
type ReceiptWire = Readonly<{
  account: string;
  chainId: string;
  to: string;
  data: Hex;
  value: "0";
  nonce: string;
  gasLimit: string;
  maxFeePerGasWei: string;
  maxPriorityFeePerGasWei: string;
}>;
type HeldSnapshot = Readonly<{
  task: ReceiptTask;
  executor: Readonly<{ digest: string }>;
  scope: Readonly<{
    phase: string;
    nonce: string;
    planDigest: string;
    journalBindingHash: string;
  }>;
  expiresAtMs: number;
}>;
type ProviderAction = (
  snapshot: HeldSnapshot,
  recheck: () => void,
) => Promise<Hex>;
type AuthorizationResult = { transactionHash: string };
type ReceiptAuthorization = {
  withAuthorization(
    claimed: ReceiptClaim,
    wire: ReceiptWire,
    action: ProviderAction,
  ): Promise<AuthorizationResult>;
};
export type ReceiptHeldRuntime = {
  state: string;
  authority: ReceiptAuthorization | null;
  inHeldGate(): boolean;
};
/** The existing Wallet createReceiptProviderHandler installation interface.
 * Inject that fixed source implementation, never a request-selected module. */
export type ReceiptProviderFactory = (options: {
  authorization: ReceiptAuthorization;
  provider: {
    request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  };
  task: ReceiptTask;
  claimed: ReceiptClaim;
  now: () => number;
}) => {
  identity(): Promise<{ account: string; chainId: number }>;
  sendTransaction(request: ReceiptActionRequest): Promise<Hex>;
};
export type ReceiptHeldLease = Readonly<{
  expiresAtMs: number;
  wallet: Readonly<{
    identity(): Promise<{ account: string; chainId: number }>;
    sendTransaction(request: ReceiptActionRequest): Promise<Hex>;
  }>;
}>;
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
const requestKeys = ["account", "chainId", "to", "data", "value"];
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
function refuse(code = "RECEIPT_HELD_ACTION_REFUSED"): never {
  throw Error(code);
}
function dataFields(raw: unknown, keys: readonly string[]) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    refuse();
  const d = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(d).length !== keys.length ||
    keys.some(
      (k) =>
        !Object.hasOwn(d, k) ||
        !Object.hasOwn(d[k]!, "value") ||
        !d[k]!.enumerable,
    )
  )
    refuse();
  return Object.fromEntries(keys.map((k) => [k, d[k]!.value])) as Record<
    string,
    unknown
  >;
}
function exactStrings(
  raw: unknown,
  expected: Record<string, string>,
  keys: readonly string[],
) {
  const values = dataFields(raw, keys);
  if (
    keys.some((k) => typeof values[k] !== "string" || values[k] !== expected[k])
  )
    refuse();
}
function fixedRequest(raw: unknown): ReceiptActionRequest {
  const r = dataFields(raw, requestKeys);
  if (
    typeof r.account !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(r.account) ||
    typeof r.to !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(r.to) ||
    !Number.isSafeInteger(r.chainId) ||
    ![31337, 560048].includes(r.chainId as number) ||
    typeof r.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2}){4,16384}$/.test(r.data) ||
    r.value !== 0n
  )
    refuse();
  return Object.freeze(r as ReceiptActionRequest);
}
function sameRequest(raw: unknown, expected: ReceiptActionRequest) {
  const actual = fixedRequest(raw);
  if (
    requestKeys.some(
      (k) =>
        actual[k as keyof ReceiptActionRequest] !==
        expected[k as keyof ReceiptActionRequest],
    )
  )
    refuse();
}
function transactionHash(raw: unknown): Hex {
  if (
    typeof raw !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw) ||
    /^0x0{64}$/i.test(raw)
  )
    refuse("RECEIPT_PROVIDER_OUTCOME_UNKNOWN");
  return raw.toLowerCase() as Hex;
}

/** ArtFi composition only. The fixed Wallet handler still performs provider
 * identity/runtime/nonce/simulation/send checks. Its authorization call enters
 * the real runtime's single gate. The handler's original provider callback is
 * exposed only as an exact, one-use lease wallet INSIDE that held gate.
 *
 * This does not establish missing receipt business/association commitments.
 * The existing authenticated native consumer remains mandatory and fail-closed;
 * an unavailable journal/CAS must throw before lease dispatch. No credential,
 * new grant/gate, HTTP endpoint, default provider or signer is constructed. */
export function createWholeReceiptHeldAction(options: {
  runtime: ReceiptHeldRuntime;
  createProviderHandler: ReceiptProviderFactory;
  provider: Parameters<ReceiptProviderFactory>[0]["provider"];
  task: ReceiptTask;
  claimed: ReceiptClaim;
  now?: () => number;
}) {
  const runtime = options.runtime,
    factory = options.createProviderHandler;
  const now = options.now ?? Date.now;
  if (
    runtime?.state !== "configured" ||
    typeof runtime.inHeldGate !== "function" ||
    typeof runtime.authority?.withAuthorization !== "function" ||
    typeof factory !== "function" ||
    typeof options.provider?.request !== "function" ||
    typeof now !== "function"
  )
    refuse("RECEIPT_RUNTIME_NOT_CONFIGURED");
  const gate = runtime.authority.withAuthorization.bind(runtime.authority);
  const inHeldGate = runtime.inHeldGate.bind(runtime);
  const provider = Object.freeze({
    request: options.provider.request.bind(options.provider),
  });
  const claimData = dataFields(options.claimed, claimKeys);
  if (claimKeys.some((k) => typeof claimData[k] !== "string")) refuse();
  const claimed = Object.freeze(claimData as ReceiptClaim);
  const taskData = dataFields(options.task, ["policy", "digest"]);
  if (taskData.digest !== claimed.taskDigest) refuse();
  // The pinned Wallet factory validates and freezes task.policy using its own
  // receiptTaskCopy. Do not normalize/re-hash that policy in ArtFi.
  const task = Object.freeze({
    policy: taskData.policy,
    digest: taskData.digest as string,
  });
  let spent = false;

  return Object.freeze({
    async authorize<T>(
      rawPrincipal: Principal,
      rawPlan: unknown,
      action: (lease: ReceiptHeldLease) => Promise<T>,
      rawRequest: ReceiptActionRequest,
    ): Promise<T> {
      if (spent || inHeldGate()) refuse("RECEIPT_GATE_REENTRY_REFUSED");
      if (typeof action !== "function") refuse();
      const projected = projectWholeReceiptBusiness(rawPlan),
        plan = projected.nativePlan;
      exactStrings(rawPrincipal, plan.taskPrincipal, principalKeys);
      exactStrings(
        { ...claimed, kind: "task" },
        {
          ...plan.taskPrincipal,
          phase: plan.wholeReceipt.phase,
          planDigest: claimed.planDigest,
          journalBindingHash: claimed.journalBindingHash,
        },
        [...claimKeys, "kind"],
      );
      const request = fixedRequest(rawRequest);
      if (
        request.account.toLowerCase() !== plan.request.account.toLowerCase() ||
        request.chainId !== plan.chainId ||
        request.to.toLowerCase() !==
          plan.wholeReceipt.domain.verifyingContract.toLowerCase()
      )
        refuse();
      let entered = false,
        actionEntered = false,
        dispatched = false,
        callbackComplete = false,
        factoryComplete = false;
      let knownHash: Hex | undefined,
        result: T | undefined,
        actionFailure: unknown;
      let dispatchPromise: Promise<Hex> | undefined;
      let actionFailed = false;
      const authorization: ReceiptAuthorization = Object.freeze({
        async withAuthorization(rawClaim, rawWire, providerAction) {
          if (
            !factoryComplete ||
            entered ||
            inHeldGate() ||
            typeof providerAction !== "function"
          )
            refuse("RECEIPT_GATE_REENTRY_REFUSED");
          exactStrings(rawClaim, claimed, claimKeys);
          const wire = Object.freeze(
            dataFields(rawWire, wireKeys),
          ) as ReceiptWire;
          // Validate before reserving the Wallet phase. This remains a pure
          // comparison, not verification of the opaque approval commitments.
          matchWholeReceiptBusiness(plan, task.policy, wire);
          if (
            wire.account.toLowerCase() !== request.account.toLowerCase() ||
            wire.chainId !== String(request.chainId) ||
            wire.to.toLowerCase() !== request.to.toLowerCase() ||
            wire.data !== request.data ||
            wire.value !== "0"
          )
            refuse();
          entered = true;
          return gate(claimed, wire, async (snapshot, recheck) => {
            if (actionEntered || callbackComplete)
              refuse("RECEIPT_CALLBACK_ALREADY_ENTERED");
            actionEntered = true;
            const active = () => {
              recheck();
              const time = now();
              if (
                callbackComplete ||
                !inHeldGate() ||
                !Number.isSafeInteger(time) ||
                time < 0 ||
                !Number.isSafeInteger(snapshot.expiresAtMs) ||
                time >= snapshot.expiresAtMs
              )
                refuse("RECEIPT_HELD_LEASE_EXPIRED");
            };
            active();
            if (
              snapshot.task.digest !== claimed.taskDigest ||
              snapshot.executor.digest !== claimed.executorDigest ||
              snapshot.scope.phase !== claimed.phase ||
              snapshot.scope.planDigest !== claimed.planDigest ||
              snapshot.scope.journalBindingHash !==
                claimed.journalBindingHash ||
              snapshot.scope.nonce !== wire.nonce
            )
              refuse();
            matchWholeReceiptBusiness(plan, snapshot.task.policy, wire);
            const lease: ReceiptHeldLease = Object.freeze({
              expiresAtMs: snapshot.expiresAtMs,
              wallet: Object.freeze({
                async identity() {
                  active();
                  const identity = await handler.identity();
                  active();
                  if (
                    identity.chainId !== plan.chainId ||
                    identity.account.toLowerCase() !==
                      plan.request.account.toLowerCase()
                  )
                    refuse();
                  return Object.freeze({
                    account: identity.account,
                    chainId: identity.chainId,
                  });
                },
                async sendTransaction(selected) {
                  if (dispatched || callbackComplete)
                    refuse("RECEIPT_PROVIDER_ALREADY_DISPATCHED");
                  sameRequest(selected, request);
                  active();
                  // Burn before await: a rejection/timeout is outcome-unknown,
                  // never permission to invoke the provider a second time.
                  dispatched = true;
                  dispatchPromise = Promise.resolve()
                    .then(() => providerAction(snapshot, recheck))
                    .then(transactionHash);
                  // Drain below even if action throws before awaiting its send.
                  void dispatchPromise.catch(() => {});
                  knownHash = await dispatchPromise;
                  return knownHash;
                },
              }),
            });
            try {
              result = await action(lease);
            } catch (error) {
              actionFailed = true;
              actionFailure = error;
              // Keep the known submission in Wallet's durable attempt even if
              // the ArtFi journal acknowledgement failed. Propagate the ArtFi
              // error AFTER the real gate settles; never report its CAS done.
            } finally {
              callbackComplete = true;
            }
            if (dispatchPromise) {
              try {
                knownHash = await dispatchPromise;
              } catch (error) {
                if (!actionFailed) {
                  actionFailed = true;
                  actionFailure = error;
                }
              }
            }
            if (!knownHash) {
              if (actionFailed) throw actionFailure;
              refuse("RECEIPT_PROVIDER_NOT_DISPATCHED");
            }
            return knownHash;
          });
        },
      });
      const handler = factory({ authorization, provider, task, claimed, now });
      if (
        !handler ||
        typeof handler.identity !== "function" ||
        typeof handler.sendTransaction !== "function"
      )
        refuse();
      factoryComplete = true;
      // The current handler factory does no I/O. No recursive factory/gate call
      // is accepted. This instance represents one actual phase attempt only.
      spent = true;
      const returned = transactionHash(await handler.sendTransaction(request));
      if (
        !entered ||
        !callbackComplete ||
        !dispatched ||
        !knownHash ||
        returned !== knownHash
      )
        refuse("RECEIPT_PROVIDER_OUTCOME_UNKNOWN");
      if (actionFailed) throw actionFailure;
      return result as T;
    },
  });
}
