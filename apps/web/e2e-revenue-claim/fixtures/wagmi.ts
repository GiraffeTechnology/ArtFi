// TEST_ONLY deterministic wallet/public-client seam. No provider, signature,
// transaction serialization or RPC network is used by this fixture.
import { useSyncExternalStore } from "react";
import type { Address, Hash, PublicClient } from "viem";
const account = "0x1000000000000000000000000000000000000003" as Address;
const hash = ("0x" + "1".repeat(64)) as Hash,
  tx = ("0x" + "7".repeat(64)) as Hash;
let wallet: {
  address: Address;
  chainId: number;
  status: "connected" | "disconnected";
} = { address: account, chainId: 560048, status: "connected" };
const listeners = new Set<() => void>(),
  releases: (() => void)[] = [];
type Mode =
  | "normal"
  | "auth-after-simulation"
  | "claimed-during-auth"
  | "reorg-on-simulate"
  | "hold-read"
  | "hold-simulate"
  | "reject-wallet"
  | "unknown-receipt"
  | "zero-balance"
  | "malformed";
export const fixture = {
  mode: "normal" as Mode,
  events: [] as string[],
  writes: [] as {
    address: unknown;
    args: string[];
    account: unknown;
    chainId: unknown;
    claimed: boolean;
  }[],
  claimed: false,
  blockHash: hash,
  simulations: 0,
  reads: 0,
  receiptCalls: 0,
  setMode(mode: Mode) {
    this.mode = mode;
  },
  setWallet(chain: number, connected = true) {
    wallet = {
      ...wallet,
      chainId: chain,
      status: connected ? "connected" : "disconnected",
    };
    for (const callback of listeners) callback();
  },
  release() {
    for (const resolve of releases.splice(0)) resolve();
  },
  auth() {
    this.events.push("auth");
    if (
      this.mode === "claimed-during-auth" ||
      (this.mode === "auth-after-simulation" && this.simulations)
    )
      this.claimed = true;
  },
  dump() {
    return {
      events: this.events,
      writes: this.writes,
      claimed: this.claimed,
      simulations: this.simulations,
      reads: this.reads,
      receiptCalls: this.receiptCalls,
    };
  },
};
const hold = () =>
  new Promise<void>((resolve) => {
    releases.push(resolve);
  });
const client = {
  getChainId: async () => {
    fixture.events.push("chain");
    return wallet.chainId;
  },
  getBlock: async () => {
    fixture.events.push("block");
    return { number: 100n, hash: fixture.blockHash };
  },
  getCode: async () => "0x6000",
  readContract: async (input: { functionName: string; args?: unknown[] }) => {
    fixture.reads++;
    fixture.events.push(input.functionName);
    if (fixture.mode === "hold-read") await hold();
    const values: Record<string, unknown> = {
      fractionToken: "0x1000000000000000000000000000000000000002",
      distributionCount: 3n,
      distributions: [
        "0x1000000000000000000000000000000000000004",
        101n,
        10n,
        20,
      ],
      claimed: fixture.claimed,
      claimable: fixture.claimed || fixture.mode === "zero-balance" ? 0n : 30n,
      totalClaimed: fixture.claimed ? 30n : 0n,
      clock: 21,
      getPastBalance: fixture.mode === "zero-balance" ? 0n : 3n,
      getPastTotalSupply: 10n,
    };
    return fixture.mode === "malformed" && input.functionName === "claimable"
      ? "30"
      : values[input.functionName];
  },
  simulateContract: async () => {
    fixture.simulations++;
    fixture.events.push("simulate");
    if (fixture.mode === "hold-simulate") await hold();
    if (fixture.mode === "reorg-on-simulate")
      fixture.blockHash = ("0x" + "2".repeat(64)) as Hash;
    return { request: { TEST_ONLY: true } };
  },
  waitForTransactionReceipt: async () => {
    fixture.events.push("receipt");
    fixture.receiptCalls++;
    if (fixture.mode === "unknown-receipt")
      throw Error("TEST_ONLY unknown receipt");
    return { status: "success", transactionHash: tx };
  },
} as unknown as PublicClient;
export function useAccount() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => wallet,
    () => wallet,
  );
}
export function usePublicClient() {
  return client;
}
export function useSignMessage() {
  return {
    signMessageAsync: async () => {
      throw Error("TEST_ONLY signMessage must not be called");
    },
  };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (input: {
      address: Address;
      args: bigint[];
      account: Address;
      chainId: number;
    }) => {
      fixture.events.push("wallet");
      fixture.writes.push({
        address: input.address,
        args: input.args.map(String),
        account: input.account,
        chainId: input.chainId,
        claimed: fixture.claimed,
      });
      if (fixture.mode === "reject-wallet")
        throw Error("TEST_ONLY wallet rejection");
      return tx;
    },
  };
}
