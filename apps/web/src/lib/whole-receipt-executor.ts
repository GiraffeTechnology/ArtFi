import "server-only";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  wholeReceiptTradeFromPlan,
  type WholeReceiptTaskPlan,
  type createWholeReceiptTaskJournal,
} from "./whole-receipt-journal";
import type { NftTaskPrincipal } from "./nft/model";
import { encodeWholeReceiptKitConfirmation } from "./whole-receipt-kit-evidence";

const abi = parseAbi([
  "function fund((address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch) sale,(bytes32 settlementId,bytes32 assetRecordHash,bytes32 oracleSourceId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment,bytes32 oldCertificateHash,bytes32 warehouseReceiptHash) correspondence,bytes signature) returns (bytes32)",
  "function paySeller(bytes32 id)",
]);
export type ReceiptWalletRequest = Readonly<{
  account: Address;
  chainId: number;
  to: Address;
  data: Hex;
  value: 0n;
}>;
export type ReceiptExecutionWallet = {
  identity(): Promise<{ account: Address; chainId: number }>;
  sendTransaction(request: ReceiptWalletRequest): Promise<Hex>;
};
export type ReceiptExecutionLease = {
  expiresAtMs: number;
  /** Provided inside the existing grant gate; must not reacquire that gate. */
  wallet?: ReceiptExecutionWallet;
};
type Journal = Pick<
  ReturnType<typeof createWholeReceiptTaskJournal>,
  "read" | "markWalletStarted" | "recordSubmission"
>;

/** Fixed installation composition only, NOT browser-controlled dependencies.
 * authorize must reuse the existing live task/grant revocation lock and hold it
 * until dispatch finishes. It must reject incomplete recovery/registration policy
 * or unapproved deployment; a public Oracle read is never sufficient. No default
 * authorizer, wallet, signer, RPC or production route is installed by this module.
 */
export function createWholeReceiptExecutor(deps: {
  journal: Journal;
  escrow: Address;
  chainId: 31337 | 560048;
  runtimeCodeHash: Hex;
  authorize<T>(
    task: NftTaskPrincipal,
    plan: WholeReceiptTaskPlan,
    action: (lease: ReceiptExecutionLease) => Promise<T>,
    request: ReceiptWalletRequest,
  ): Promise<T>;
  /** Legacy fixed composition, mutually exclusive with a lease-bound wallet. */
  wallet?: ReceiptExecutionWallet;
  chain: {
    getChainId(): Promise<number>;
    getCode(address: Address): Promise<Hex>;
    simulate(request: ReceiptWalletRequest): Promise<void>;
  };
}) {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const refuse = (): never => {
    throw Error("RECEIPT_EXECUTION_REFUSED");
  };
  if (
    ![31337, 560048].includes(deps.chainId) ||
    !/^0x[0-9a-fA-F]{40}$/.test(deps.escrow) ||
    /^0x0{40}$/i.test(deps.escrow) ||
    !/^0x[0-9a-fA-F]{64}$/.test(deps.runtimeCodeHash) ||
    /^0x0{64}$/i.test(deps.runtimeCodeHash)
  )
    refuse();
  return Object.freeze({
    async execute(
      task: NftTaskPrincipal,
      id: string,
      sellerSignature?: Hex,
      kitAdmission?: { version: bigint; proof: Hex },
    ) {
      const current = await deps.journal.read(task, id);
      if (
        current.walletStarted ||
        current.transactionHash ||
        current.status !== "awaiting-wallet"
      )
        throw Error("RECEIPT_RECOVER_EXISTING_OPERATION");
      const plan = structuredClone(current.plan),
        trade = wholeReceiptTradeFromPlan(plan);
      if (
        trade.domain.chainId !== deps.chainId ||
        !same(trade.domain.verifyingContract, deps.escrow)
      )
        refuse();
      const phase = plan.wholeReceipt.phase;
      const registration = plan.wholeReceipt.kitRegistration;
      if (phase === "registered") {
        if (
          sellerSignature !== undefined ||
          !kitAdmission ||
          !registration ||
          BigInt(registration.version) !== kitAdmission.version ||
          !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(kitAdmission.proof) ||
          !same(keccak256(kitAdmission.proof), registration.proofHash)
        )
          refuse();
      } else if (kitAdmission !== undefined) refuse();
      if (
        phase === "funded" &&
        (!sellerSignature ||
          !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(sellerSignature))
      )
        refuse();
      if (phase === "paid" && sellerSignature !== undefined) refuse();
      const request: ReceiptWalletRequest = Object.freeze({
        account: plan.request.account as Address,
        chainId: deps.chainId,
        to: deps.escrow,
        value: 0n,
        data:
          phase === "registered"
            ? encodeWholeReceiptKitConfirmation(
                plan,
                plan.wholeReceipt.segmentId as Hex,
                kitAdmission!,
              ).data
            : phase === "funded"
              ? encodeFunctionData({
                  abi,
                  functionName: "fund",
                  args: [trade.sale, trade.correspondence, sellerSignature!],
                })
              : encodeFunctionData({
                  abi,
                  functionName: "paySeller",
                  args: [plan.wholeReceipt.segmentId as Hex],
                }),
      });
      let entered = false;
      return deps.authorize(
        task,
        structuredClone(plan),
        async (lease) => {
          if (entered) refuse();
          entered = true;
          // Exactly one installed wallet source. Never fallback from a malformed
          // gate-bound capability to an unrelated static provider.
          if (lease.wallet !== undefined && deps.wallet !== undefined) refuse();
          const executionWallet = lease.wallet ?? deps.wallet;
          if (
            !executionWallet ||
            typeof executionWallet.identity !== "function" ||
            typeof executionWallet.sendTransaction !== "function"
          )
            refuse();
          const active = () => {
            if (
              !Number.isSafeInteger(lease.expiresAtMs) ||
              Date.now() >= lease.expiresAtMs
            )
              refuse();
          };
          const identity = async () => {
            const wallet = await executionWallet!.identity();
            if (
              wallet.chainId !== deps.chainId ||
              !same(wallet.account, request.account)
            )
              refuse();
          };
          active();
          await identity();
          if ((await deps.chain.getChainId()) !== deps.chainId) refuse();
          const code = await deps.chain.getCode(deps.escrow);
          if (code === "0x" || !same(keccak256(code), deps.runtimeCodeHash))
            refuse();
          await deps.chain.simulate(request);
          active();
          await identity();
          active();
          // Durable CAS precedes the first wallet side effect. If its response is
          // lost, or wallet dispatch throws, the marker stays set: no automatic retry.
          const started = await deps.journal.markWalletStarted(task, current);
          active();
          await identity();
          active();
          let hash: Hex;
          try {
            hash = await executionWallet!.sendTransaction(request);
          } catch {
            throw Error("RECEIPT_WALLET_OUTCOME_UNKNOWN_RECOVER_JOURNAL");
          }
          if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
            throw Error("RECEIPT_WALLET_OUTCOME_UNKNOWN_RECOVER_JOURNAL");
          try {
            return await deps.journal.recordSubmission(task, started, hash);
          } catch {
            // Public transaction hash is retained for reconciliation, never a reason
            // to invoke the wallet again. Signature/calldata never enter the journal.
            return {
              status: "submission-recording-unknown" as const,
              operationId: id,
              transactionHash: hash,
            };
          }
        },
        request,
      );
    },
  });
}
