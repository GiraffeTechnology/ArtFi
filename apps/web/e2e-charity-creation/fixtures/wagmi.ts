import { useSyncExternalStore } from "react";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
} from "viem";
import { charityEditionsAbi } from "../../src/lib/contracts";
export const actor = "0x1000000000000000000000000000000000000001" as Address,
  collection = "0x1000000000000000000000000000000000000002" as Address;
const hash = `0x${"a".repeat(64)}` as Hex,
  blockHash = `0x${"b".repeat(64)}` as Hex;
export const fields = {
  artworkId: `0x${"1".repeat(64)}`,
  masterArtworkHash: `0x${"2".repeat(64)}`,
  metadataHash: `0x${"3".repeat(64)}`,
  distributionWallet: actor,
  metadataURI: "ipfs://TEST_ONLY/no-preview.json",
};
let version = 0,
  wallet = { address: actor, isConnected: true };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const notify = () => {
  version++;
  listeners.forEach((fn) => fn());
};
let walletRelease: ((hash: Hex) => void) | undefined,
  receiptRelease: ((r: unknown) => void) | undefined,
  simulationRelease: ((r: unknown) => void) | undefined;
export const fixture = {
  chainId: 560048,
  readerChain: 560048,
  mode: "success",
  supply: 100n,
  balance: 100n,
  role: true,
  paused: false,
  reorg: false,
  blockChecks: 0,
  eventMismatch: false,
  writes: [] as {
    functionName: string;
    address: string;
    account?: string;
    args: unknown[];
  }[],
  simulations: [] as unknown[],
  reads: [] as { functionName: string; blockNumber?: bigint }[],
  setWallet(chainId: number, connected = true) {
    fixture.chainId = chainId;
    wallet = { address: actor, isConnected: connected };
    notify();
  },
  setRole(value: boolean) {
    fixture.role = value;
    notify();
  },
  releaseWallet() {
    walletRelease?.(hash);
    walletRelease = undefined;
  },
  releaseReceipt() {
    receiptRelease?.(receipt());
    receiptRelease = undefined;
  },
  releaseSimulation() {
    simulationRelease?.({});
    simulationRelease = undefined;
  },
};
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
export function useReadContract(input: {
  functionName: string;
  query?: { enabled?: boolean };
}) {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  if (input.query?.enabled === false) return { data: undefined };
  const f = input.functionName;
  return {
    data:
      f === "SERIES_CREATOR_ROLE"
        ? hash
        : f === "hasRole"
          ? fixture.role
          : f === "EDITIONS_PER_ARTWORK"
            ? 100n
            : f === "PRIMARY_PRICE_WEI"
              ? 10000000000000000n
              : f === "seriesCount"
                ? 1n
                : f === "paused"
                  ? fixture.paused
                  : false,
  };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (input: {
      functionName: string;
      address: string;
      account?: string;
      args: unknown[];
    }) => {
      fixture.writes.push({ ...input });
      if (fixture.mode === "reject")
        throw Object.assign(Error("TEST_ONLY wallet rejected"), { code: 4001 });
      if (fixture.mode === "hashless")
        return new Promise<Hex>((resolve) => {
          walletRelease = resolve;
        });
      return hash;
    },
  };
}
function receipt() {
  return {
    transactionHash: fixture.mode === "wrong-hash" ? blockHash : hash,
    status: fixture.mode === "revert" ? "reverted" : "success",
    blockNumber: 77n,
    blockHash,
    logs: [
      {
        address: collection,
        topics: encodeEventTopics({
          abi: charityEditionsAbi,
          eventName: "SeriesCreated",
          args: {
            tokenId: 7n,
            artworkId: (fixture.eventMismatch ? hash : fields.artworkId) as Hex,
            masterArtworkHash: fields.masterArtworkHash as Hex,
          },
        }),
        data: encodeAbiParameters(
          [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
          [actor, fields.metadataHash as Hex, fields.metadataURI],
        ),
      },
    ],
  };
}
const client = {
  async simulateContract(input: unknown) {
    fixture.simulations.push(input);
    if (fixture.mode === "simulation-error")
      throw Error("TEST_ONLY simulation rejected");
    if (fixture.mode === "simulation-pending")
      return new Promise((resolve) => {
        simulationRelease = resolve;
      });
    return {};
  },
  async waitForTransactionReceipt(options?: {
    onReplaced?: (value: unknown) => void;
  }) {
    if (fixture.mode === "pending")
      throw Error("TEST_ONLY receipt unavailable");
    if (fixture.mode === "receipt-late")
      return new Promise((resolve) => {
        receiptRelease = resolve;
      });
    const found = receipt();
    if (fixture.mode === "repriced" || fixture.mode === "cancelled") {
      found.transactionHash = `0x${"c".repeat(64)}` as Hex;
      options?.onReplaced?.({
        reason: fixture.mode === "repriced" ? "repriced" : "cancelled",
        transactionReceipt: found,
      });
    }
    return found;
  },
  async getChainId() {
    return fixture.readerChain;
  },
  async getBlock() {
    fixture.blockChecks++;
    return {
      number: 77n,
      hash: fixture.reorg && fixture.blockChecks > 1 ? hash : blockHash,
    };
  },
  async readContract(input: { functionName: string; blockNumber?: bigint }) {
    fixture.reads.push(input);
    return input.functionName === "totalSupply"
      ? fixture.supply
      : fixture.balance;
  },
};
export function usePublicClient() {
  return client;
}
