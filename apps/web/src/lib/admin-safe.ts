import {
  encodeAbiParameters,
  keccak256,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import { artFiAdminSafeAbi } from "./contracts";

/// Once a privileged role is held by `ArtFiAdminSafe`, a connected wallet can no longer
/// call the target contract directly: the safe is a contract, not a signer. Every such
/// call becomes a proposal that reaches the target only after the owner threshold is met
/// and the timelock has elapsed.
///
/// The three operator flows — RWA creation, DAO creation and charity edition creation —
/// differ only in which target and which calldata they propose, so the proposal shape
/// lives here once rather than three times.

/** A privileged call, before it is wrapped as a safe proposal. */
export type PrivilegedCall = {
  /** Idempotency key. The safe binds it to the proposal's content on first submission. */
  requestId: Hex;
  target: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};

/** The arguments `ArtFiAdminSafe.submit` expects, in order. */
export type SafeSubmission = {
  requestId: Hex;
  target: Address;
  value: bigint;
  data: Hex;
};

/**
 * Wrap a privileged call as a safe submission.
 *
 * `value` is always zero. None of the three operator calls transfers ETH, and a proposal
 * that could carry value would let a mis-encoded argument move the safe's balance.
 */
export function encodeSafeSubmission(call: PrivilegedCall): SafeSubmission {
  if (call.target === ZERO_ADDRESS) {
    throw new Error("A safe proposal cannot target the zero address.");
  }
  if (call.requestId === ZERO_REQUEST_ID) {
    throw new Error("A safe proposal requires a non-zero request id.");
  }
  return {
    requestId: call.requestId,
    target: call.target,
    value: 0n,
    data: encodeFunctionData({
      abi: call.abi as Abi,
      functionName: call.functionName,
      args: call.args as never,
    }),
  };
}

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;
export const ZERO_REQUEST_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** The stage a proposal has reached, as far as a viewer can tell from safe state. */
export type ProposalStage =
  | "unknown"
  | "awaiting-confirmations"
  | "awaiting-timelock"
  | "executable"
  | "executed";

export type SafeTransactionState = {
  target: Address;
  readyAt: bigint;
  confirmations: number;
  executed: boolean;
};

/**
 * Decide what a proposal is waiting for.
 *
 * `readyAt` is zero until the confirmation count first reaches the threshold, and the
 * safe resets it to zero if a revocation drops the count back below. A non-zero
 * `readyAt` therefore means the threshold is currently met, and the remaining question
 * is only whether the timelock has elapsed.
 *
 * `nowSeconds` is passed in rather than read from the clock so that a caller can resolve
 * the stage against chain time rather than the viewer's device, which may be skewed.
 */
export function proposalStage(
  state: SafeTransactionState | undefined,
  threshold: bigint,
  nowSeconds: bigint,
): ProposalStage {
  if (!state || state.target === ZERO_ADDRESS) return "unknown";
  if (state.executed) return "executed";
  if (BigInt(state.confirmations) < threshold) return "awaiting-confirmations";
  if (state.readyAt === 0n) return "awaiting-confirmations";
  if (nowSeconds < state.readyAt) return "awaiting-timelock";
  return "executable";
}

/** Seconds remaining before a proposal can execute; zero once it is executable. */
export function secondsUntilExecutable(
  state: SafeTransactionState | undefined,
  nowSeconds: bigint,
): bigint {
  if (!state || state.readyAt === 0n) return 0n;
  const remaining = state.readyAt - nowSeconds;
  return remaining > 0n ? remaining : 0n;
}

/** The read call that answers whether a connected wallet may propose at all. */
export function ownerCheck(safeAddress: Address, account: Address) {
  return {
    address: safeAddress,
    abi: artFiAdminSafeAbi,
    functionName: "isOwner",
    args: [account],
  } as const;
}

/** Keep the target's operation identity intact while binding a safe proposal to exact call bytes. */
export function safeProposalRequestId(
  operationId: Hex,
  target: Address,
  data: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      [operationId, target, keccak256(data)],
    ),
  );
}

export function encodeOperatorSafeSubmission(
  call: PrivilegedCall,
): SafeSubmission {
  const submission = encodeSafeSubmission(call);
  return {
    ...submission,
    requestId: safeProposalRequestId(
      call.requestId,
      call.target,
      submission.data,
    ),
  };
}
