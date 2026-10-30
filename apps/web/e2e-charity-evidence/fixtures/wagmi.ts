import { useSyncExternalStore } from "react";
import {
  encodeEventTopics,
  encodeFunctionData,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { charityEditionsAbi } from "../../src/lib/contracts";
export const actor = "0x1000000000000000000000000000000000000001" as Address,
  target = "0x1000000000000000000000000000000000000002" as Address;
const tx = `0x${"a".repeat(64)}` as Hex,
  next = `0x${"c".repeat(64)}` as Hex,
  blockHash = `0x${"b".repeat(64)}` as Hex,
  evidenceHash = `0x${"4".repeat(64)}` as Hex;
let version = 0,
  wallet = { address: actor, isConnected: true };
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
const notify = () => {
  version++;
  listeners.forEach((f) => f());
};
let walletRelease: ((h: Hex) => void) | undefined,
  simulationRelease: ((r: unknown) => void) | undefined;
export const fixture = {
  mode: "success",
  chainId: 560048,
  readerChain: 560048,
  balance: 0n,
  paused: false,
  soldOut: false,
  mined: false,
  reads: [] as { functionName: string; blockNumber?: bigint }[],
  writes: [] as { functionName: string; args: unknown[]; account?: string }[],
  simulations: [] as unknown[],
  setWallet(chain: number, connected = true) {
    fixture.chainId = chain;
    wallet = { address: actor, isConnected: connected };
    notify();
  },
  releaseWallet() {
    walletRelease?.(tx);
    walletRelease = undefined;
  },
  releaseSimulation() {
    simulationRelease?.({});
    simulationRelease = undefined;
  },
};
function record() {
  const key = Object.keys(sessionStorage).find((k) =>
    k.startsWith("artfi:setup:charity-evidence:"),
  );
  return key ? JSON.parse(sessionStorage.getItem(key)!).data : undefined;
}
function action() {
  return (
    fixture.writes.at(-1)?.functionName ??
    (record()?.action === "donation"
      ? "recordPhysicalDonation"
      : "recordSellout")
  );
}
function series() {
  const donation = action() === "recordPhysicalDonation";
  return {
    createdAt: 1n,
    distributionWallet: actor,
    soldOutAt: fixture.mined
      ? donation
        ? 5n
        : 10n
      : fixture.soldOut
        ? 5n
        : 0n,
    physicalDonationRecordedAt: fixture.mined && donation ? 10n : 0n,
    selloutEvidenceHash:
      fixture.mined || fixture.soldOut ? evidenceHash : zeroHash,
    physicalDonationEvidenceHash:
      fixture.mined && donation ? evidenceHash : zeroHash,
  };
}
function receipt() {
  return {
    transactionHash: fixture.mode === "wrong-hash" ? next : tx,
    blockNumber: 77n,
    blockHash,
    status: fixture.mode.startsWith("revert") ? "reverted" : "success",
    logs: [
      {
        address: target,
        removed: false,
        topics: encodeEventTopics({
          abi: charityEditionsAbi,
          eventName:
            action() === "recordPhysicalDonation"
              ? "PhysicalDonationRecorded"
              : "SelloutRecorded",
          args: {
            tokenId: 7n,
            evidenceHash: fixture.mode === "event-mismatch" ? tx : evidenceHash,
          },
        }),
        data: "0x",
      },
    ],
  };
}
export function useAccount() {
  return useSyncExternalStore(
    subscribe,
    () => wallet,
    () => wallet,
  );
}
export function useChainId() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return fixture.chainId;
}
export function useReadContract() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return { data: undefined };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (input: {
      functionName: string;
      args: unknown[];
      account?: string;
    }) => {
      fixture.writes.push({ ...input });
      if (fixture.mode === "reject")
        throw Object.assign(Error("TEST_ONLY wallet rejected"), { code: 4001 });
      if (fixture.mode === "hashless")
        return new Promise<Hex>((resolve) => {
          walletRelease = resolve;
        });
      return tx;
    },
  };
}
const client = {
  async getChainId() {
    return fixture.readerChain;
  },
  async getBlock(input?: { blockNumber?: bigint }) {
    return input?.blockNumber === 77n
      ? {
          number: 77n,
          hash: fixture.mode.includes("noncanonical") ? next : blockHash,
          timestamp: 10n,
        }
      : { number: 76n, hash: blockHash, timestamp: 9n };
  },
  async readContract(input: { functionName: string; blockNumber?: bigint }) {
    fixture.reads.push(input);
    if (input.functionName === "series") return series();
    if (input.functionName === "paused") return fixture.paused;
    if (input.functionName === "balanceOf") return fixture.balance;
    if (input.functionName === "hasRole") return true;
    if (input.functionName === "isOwner") return true;
    throw Error("Unexpected TEST_ONLY read " + input.functionName);
  },
  async simulateContract(input: unknown) {
    fixture.simulations.push(input);
    if (fixture.mode === "simulation-pending")
      return new Promise((resolve) => {
        simulationRelease = resolve;
      });
    return {};
  },
  async getTransaction({ hash }: { hash: Hex }) {
    return {
      hash,
      from: actor,
      to: target,
      value: 0n,
      nonce: hash === next && fixture.mode === "wrong-nonce" ? 6 : 5,
      input: encodeFunctionData({
        abi: charityEditionsAbi,
        functionName:
          action() === "recordPhysicalDonation"
            ? "recordPhysicalDonation"
            : "recordSellout",
        args: [7n, evidenceHash],
      }),
    };
  },
  async waitForTransactionReceipt(options: {
    onReplaced?: (value: unknown) => void;
  }) {
    if (fixture.mode === "pending")
      throw Error("TEST_ONLY receipt unavailable");
    fixture.mined = true;
    const found = receipt();
    if (fixture.mode === "revert-foreign") fixture.readerChain = 1;
    if (["repriced", "cancelled", "wrong-nonce"].includes(fixture.mode)) {
      found.transactionHash = next;
      options.onReplaced?.({
        reason: fixture.mode === "repriced" ? "repriced" : "cancelled",
        transactionReceipt: found,
      });
    }
    return found;
  },
  async getTransactionReceipt() {
    return receipt();
  },
};
export function usePublicClient() {
  return client;
}
