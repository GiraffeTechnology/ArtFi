import { useSyncExternalStore } from "react";
import {
  encodeFunctionData,
  type Abi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const buyer = "0x1000000000000000000000000000000000000010" as Address;
export const seller = "0x1000000000000000000000000000000000000020" as Address;
export const market = "0x1000000000000000000000000000000000000003" as Address;
export const asset = "0x1000000000000000000000000000000000000004" as Address;
export const payment = "0x1000000000000000000000000000000000000005" as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
let account = {
  address: buyer,
  chainId: 560048,
  status: "connected" as const,
  isConnected: true,
};
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
const snapshot = () => account;
let releaseSimulation: (() => void) | undefined;
let heldSimulation: Promise<void> | undefined;
export const state = {
  receiptMode: "normal",
  receiptPhase: false,
  ends: 1100,
  highest: 0n,
  bidder: zeroAddress as Address,
  allowance: 0n,
  approvalChange: false,
  unknownApproval: false,
  simulationEntered: false,
  simulationCompleted: false,
  postSimulationBalance: false,
  postSimulationFinalChain: false,
  writes: [] as Record<string, unknown>[],
  receiptReads: [] as Hex[],
};
const reader = {
  getChainId: async () => {
    if (state.postSimulationBalance) state.postSimulationFinalChain = true;
    return state.receiptPhase && state.receiptMode === "chain-flip"
      ? 1
      : 560048;
  },
  getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({
    number: blockNumber ?? 100n,
    hash:
      state.receiptPhase &&
      ["reorg", "reorg-revert"].includes(state.receiptMode)
        ? hash(78)
        : hash(77),
    timestamp: 1000n,
  }),
  getLogs: async () => [],
  async readContract({ functionName }: { functionName: string }) {
    if (functionName === "balanceOf" && state.simulationCompleted)
      state.postSimulationBalance = true;
    const values: Record<string, unknown> = {
      listings: [
        seller,
        asset,
        payment,
        10n,
        100n,
        900,
        state.ends,
        1,
        1,
        state.bidder,
        state.highest,
      ],
      auctionTerms: [120n, 5n, state.ends, 300, 300],
      paused: false,
      symbol: "TEST",
      decimals: 0,
      credits: 0n,
      balanceOf: 10000n,
      allowance: state.allowance,
      pilotPaymentCap: 10000n,
      pilotPaymentUsed: 0n,
      allowedPaymentToken: true,
      allowedAssetToken: true,
    };
    if (!(functionName in values))
      throw Error(`TEST_ONLY unsupported read ${functionName}`);
    return values[functionName];
  },
  async simulateContract(request: Record<string, unknown>) {
    state.simulationEntered = true;
    if (heldSimulation) await heldSimulation;
    state.simulationCompleted = true;
    return { request };
  },
  async getTransaction({ hash: tx }: { hash: Hex }) {
    if (state.receiptMode === "missing-original")
      throw Error("TEST_ONLY missing original transaction");
    const raw = sessionStorage.getItem("TEST_ONLY:auction:transaction:" + tx);
    if (!raw) throw Error("TEST_ONLY original transaction bytes absent");
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      value: BigInt(parsed.value),
      blockNumber: 101n,
      ...(state.receiptPhase && state.receiptMode === "wrong-nonce"
        ? { nonce: parsed.nonce + 1 }
        : {}),
    };
  },
  async waitForTransactionReceipt({
    hash: originalHash,
    onReplaced,
  }: {
    hash: Hex;
    onReplaced?: (event: unknown) => void;
  }) {
    state.receiptReads.push(originalHash);
    state.receiptPhase = true;
    const originalRaw = sessionStorage.getItem(
      "TEST_ONLY:auction:transaction:" + originalHash,
    );
    if (!originalRaw) throw Error("TEST_ONLY original bytes unavailable");
    const original = JSON.parse(originalRaw);
    if (original.method === "approve") {
      if (state.unknownApproval)
        throw Error("TEST_ONLY unavailable approval receipt");
      state.allowance = 100n;
      if (state.approvalChange) state.ends = 1400;
    } else if (original.method === "placeBid") {
      state.highest = 100n;
      state.bidder = buyer;
    }
    let transactionHash = originalHash;
    if (
      ["repriced", "changed-call", "cancelled", "replaced"].includes(
        state.receiptMode,
      )
    ) {
      transactionHash = hash(999 + original.nonce);
      sessionStorage.setItem(
        "TEST_ONLY:auction:transaction:" + transactionHash,
        JSON.stringify({
          ...original,
          hash: transactionHash,
          ...(["changed-call", "cancelled", "replaced"].includes(
            state.receiptMode,
          )
            ? { input: "0xabcd" }
            : {}),
        }),
      );
      onReplaced?.({
        reason:
          state.receiptMode === "cancelled"
            ? "cancelled"
            : state.receiptMode === "replaced"
              ? "replaced"
              : "repriced",
        transactionReceipt: { transactionHash },
      });
    }
    if (state.receiptMode === "wrong-hash") transactionHash = hash(998);
    return {
      status: ["reverted", "reorg-revert"].includes(state.receiptMode)
        ? "reverted"
        : state.receiptMode === "unknown-status"
          ? "pending"
          : "success",
      transactionHash,
      blockHash: hash(77),
      blockNumber: 101n,
      logs: [],
    };
  },
};
export const fixture = {
  state,
  buyer,
  market,
  asset,
  payment,
  client: reader as unknown as PublicClient,
  holdSimulation() {
    heldSimulation = new Promise<void>((resolve) => {
      releaseSimulation = resolve;
    });
  },
  releaseSimulation() {
    releaseSimulation?.();
    heldSimulation = undefined;
  },
  switchWallet() {
    account = { ...account, address: seller };
    listeners.forEach((f) => f());
  },
};
export function useAccount() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function usePublicClient() {
  return fixture.client;
}
export function useSignMessage() {
  return { signMessageAsync: async () => "0x00" as Hex };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (request: Record<string, unknown>) => {
      state.writes.push(request);
      const tx = hash(state.writes.length);
      const original = {
        hash: tx,
        from: request.account,
        to: request.address,
        input: encodeFunctionData({
          abi: request.abi as Abi,
          functionName: String(request.functionName),
          args: request.args as unknown[],
        }),
        value: String(request.value ?? 0),
        nonce: state.writes.length + 7,
        chainId: request.chainId,
        blockHash: hash(77),
        method: request.functionName,
      };
      sessionStorage.setItem(
        "TEST_ONLY:auction:transaction:" + tx,
        JSON.stringify(original),
      );
      return tx;
    },
  };
}
