import "server-only";
import type { Hex } from "viem";
import {
  createNftTaskJournal,
  type NftTaskJournalConfig,
} from "./nft/task-journal";
import {
  createWholeReceiptHeldAction,
  type ReceiptActionRequest,
  type ReceiptHeldRuntime,
} from "./whole-receipt-held-action";
import { createWholeReceiptNativeJournal } from "./whole-receipt-journal-composition";
import type {
  ReceiptJournalOperation,
  ReceiptPreparationRuntime,
} from "./whole-receipt-prepared-journal";

type Plan = ReceiptJournalOperation["plan"];
type HeldOptions = Parameters<typeof createWholeReceiptHeldAction>[0];
export type ReceiptExecutionCompositionOptions = Omit<
  HeldOptions,
  "runtime"
> & {
  runtime: ReceiptHeldRuntime & ReceiptPreparationRuntime;
  journalConfig: NftTaskJournalConfig<Plan>;
};
export type ReceiptExecutionResult =
  | Readonly<{ status: "pending"; operation: ReceiptJournalOperation }>
  | Readonly<{
      status: "submission-recording-unknown";
      operationId: string;
      transactionHash: Hex;
    }>;

export class ReceiptExecutionContextError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReceiptExecutionContextError";
  }
}
function fail(code: string): never {
  throw new ReceiptExecutionContextError(code);
}
function requestSnapshot(raw: ReceiptActionRequest): ReceiptActionRequest {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype)
    fail("RECEIPT_EXECUTION_REQUEST_REFUSED");
  const keys = ["account", "chainId", "to", "data", "value"] as const;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(descriptors, key) ||
        !descriptors[key]!.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    fail("RECEIPT_EXECUTION_REQUEST_REFUSED");
  // The existing held-action boundary validates every field and exact approved
  // calldata. Copy own data properties before the first asynchronous read.
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])),
  ) as ReceiptActionRequest;
}
function transactionHash(raw: unknown): Hex {
  if (
    typeof raw !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(raw) ||
    /^0x0{64}$/i.test(raw)
  )
    fail("RECEIPT_WALLET_OUTCOME_UNKNOWN_READ_FIRST");
  return raw.toLowerCase() as Hex;
}

/** Installation-owned application composition. Preparation and recovery reuse
 * the fixed native journal. Execution reuses Wallet's existing single held
 * authorization callback: durable CAS, exactly one lease dispatch, then durable
 * hash acknowledgement. This constructs no signer, grant, endpoint, credential,
 * provider fallback or source authority. It does not confirm chain settlement.
 */
export function createWholeReceiptExecutionComposition(
  options: ReceiptExecutionCompositionOptions,
) {
  const runtime = options.runtime;
  const held = createWholeReceiptHeldAction(options);
  const inHeldGate = runtime.inHeldGate.bind(runtime);
  const prepared = createWholeReceiptNativeJournal({
    runtime,
    claimed: options.claimed,
    journalConfig: options.journalConfig,
    now: options.now,
  });
  const nativeJournal = createNftTaskJournal<Plan>(options.journalConfig);
  let executing = false;

  return Object.freeze({
    operationId: prepared.operationId,
    create: prepared.create,
    read: prepared.read,
    async execute(
      rawRequest: ReceiptActionRequest,
    ): Promise<ReceiptExecutionResult> {
      if (executing || inHeldGate()) fail("RECEIPT_EXECUTION_REENTRY_REFUSED");
      const request = requestSnapshot(rawRequest);
      executing = true;
      try {
        // Review is read-only and may reconcile the original operation after
        // expiry/revocation. It does not reserve a new execution phase.
        const { operation } = await prepared.read("review");
        if (
          operation.walletStarted ||
          operation.transactionHash ||
          operation.status !== "awaiting-wallet"
        )
          fail("RECEIPT_RECOVER_EXISTING_OPERATION");
        const principal = operation.plan.taskPrincipal;
        return await held.authorize(
          principal,
          operation.plan,
          async (lease) => {
            const active = async () => {
              if (!inHeldGate()) fail("RECEIPT_EXECUTION_GATE_NOT_HELD");
              // The lease rechecks runtime revocation/expiry and provider identity.
              await lease.wallet.identity();
              if (!inHeldGate()) fail("RECEIPT_EXECUTION_GATE_NOT_HELD");
            };
            await active();
            const started = await nativeJournal(principal, "update", {
              ...operation,
              walletStarted: true,
            });
            // A lost CAS reply never permits a wallet send or automatic retry.
            await active();
            let hash: Hex;
            try {
              hash = transactionHash(
                await lease.wallet.sendTransaction(request),
              );
            } catch {
              fail("RECEIPT_WALLET_OUTCOME_UNKNOWN_READ_FIRST");
            }
            try {
              if (!inHeldGate()) fail("RECEIPT_EXECUTION_GATE_NOT_HELD");
              const submitted = await nativeJournal(principal, "update", {
                ...started,
                status: "pending",
                walletStarted: true,
                transactionHash: hash,
              });
              if (submitted.walletStarted !== true)
                fail("RECEIPT_SUBMISSION_ACK_REFUSED");
              const recorded: ReceiptJournalOperation = {
                ...submitted,
                walletStarted: true,
              };
              return Object.freeze({
                status: "pending" as const,
                operation: recorded,
              });
            } catch {
              // Wallet's held-action wrapper retains this known hash even when
              // ArtFi's durable acknowledgement is unavailable. No second send.
              return Object.freeze({
                status: "submission-recording-unknown" as const,
                operationId: operation.id,
                transactionHash: hash,
              });
            }
          },
          request,
        );
      } finally {
        executing = false;
      }
    },
  });
}
