// TEST_ONLY deterministic public-chain and wallet-hook seam. No RPC, real
// signature, serialization, provider or transaction broadcast occurs here.
import { useSyncExternalStore } from "react";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { hoodi } from "viem/chains";
import { daoActionsAbi } from "../../src/lib/dao-contracts";
import { proposalPackageId } from "../../src/lib/dao-action-state";
import { publishedProposalEvent } from "../../src/lib/dao-published-execution";
const a = (n: string) => ("0x" + n.repeat(40)) as Address;
const h = (n: string) => ("0x" + n.repeat(64)) as Hash;
export const deployment = {
  governorAddress: a("1"),
  actionRegistryAddress: a("2"),
  tokenAddress: a("3"),
  vaultAddress: a("4"),
};
const account = a("5"),
  tx = h("7"),
  replacement = h("8");
const query = new URLSearchParams(window.location.search);
let wallet = {
  address: account,
  chainId: 560048,
  status: "connected" as "connected" | "disconnected",
  isConnected: true,
};
const listeners = new Set<() => void>(),
  releases: (() => void)[] = [];
const calldata = encodeFunctionData({
  abi: daoActionsAbi,
  functionName: "recordMarketMigration",
  args: [h("a"), h("b"), "https://evidence.invalid/TEST_ONLY"],
});
const description = "TEST_ONLY published migration";
const proposal = {
  targets: [deployment.actionRegistryAddress] as const,
  values: [0n] as const,
  calldatas: [calldata] as const,
  description,
  descriptionHash: keccak256(stringToHex(description)),
};
const proposalId = proposalPackageId(proposal);
const log = {
  address: deployment.governorAddress,
  topics: encodeEventTopics({
    abi: [publishedProposalEvent],
    eventName: "ProposalCreated",
  }),
  data: encodeAbiParameters(publishedProposalEvent.inputs, [
    proposalId,
    account,
    proposal.targets,
    proposal.values,
    [""],
    proposal.calldatas,
    10n,
    20n,
    description,
  ]),
  removed: false,
  blockNumber: 50n,
  blockHash: h("c"),
  transactionHash: h("d"),
  transactionIndex: 0,
  logIndex: 0,
};
const hold = () => new Promise<void>((resolve) => releases.push(resolve));
type Call = {
  address: Address;
  input: Hex;
  functionName: string;
  account: Address;
  chainId: number;
  state: number;
  balance: string;
  simulations: number;
};
export const fixture = {
  mode: query.get("mode") || "normal",
  state:
    query.get("mode") === "execute" || query.get("mode") === "timelock" ? 5 : 4,
  eta: query.get("mode") === "timelock" ? 1001n : 990n,
  balance: 1n,
  creationHash: h("c"),
  observationHash: h("e"),
  events: [] as string[],
  writes: [] as Call[],
  simulations: 0,
  receipts: 0,
  auths: 0,
  reads: 0,
  setMode(mode: string) {
    this.mode = mode;
  },
  setState(state: number) {
    this.state = state;
  },
  setWallet(chain: number, connected = true, address = account) {
    wallet = {
      address,
      chainId: chain,
      status: connected ? "connected" : "disconnected",
      isConnected: connected,
    };
    for (const f of listeners) f();
  },
  release() {
    for (const f of releases.splice(0)) f();
  },
  auth() {
    this.auths++;
    this.events.push("auth");
    if (this.simulations > 0) {
      if (this.mode === "auth-state-change") this.state = 7;
      if (this.mode === "auth-membership-change") this.balance = 0n;
    }
  },
  dump() {
    return {
      events: this.events,
      writes: this.writes,
      simulations: this.simulations,
      receipts: this.receipts,
      auths: this.auths,
      reads: this.reads,
      state: this.state,
      balance: String(this.balance),
    };
  },
};
function originalCall() {
  const raw = sessionStorage.getItem("TEST_ONLY-dao-wallet-call");
  if (!raw) throw Error("TEST_ONLY missing original fixture call");
  return JSON.parse(raw) as Call;
}
const client = {
  chain: hoodi,
  getChainId: async () => {
    fixture.events.push("chain");
    return wallet.chainId;
  },
  getTransactionReceipt: async () => {
    fixture.events.push("creation");
    if (fixture.mode === "hold-read") await hold();
    return {
      status: "success",
      transactionHash: h("d"),
      blockNumber: 50n,
      blockHash: h("c"),
      logs: fixture.mode === "duplicate-event" ? [log, log] : [log],
    };
  },
  getBlock: async (input: { blockNumber?: bigint }) =>
    input.blockNumber === 50n
      ? { number: 50n, hash: fixture.creationHash, timestamp: 900n }
      : input.blockNumber === 120n
        ? { number: 120n, hash: h("f"), timestamp: 1100n }
        : { number: 100n, hash: fixture.observationHash, timestamp: 1000n },
  getCode: async () => "0x6000",
  readContract: async (input: {
    functionName: string;
    blockNumber: bigint;
    args?: unknown[];
  }) => {
    fixture.reads++;
    fixture.events.push(input.functionName);
    const values: Record<string, unknown> = {
      rwaVault: deployment.vaultAddress,
      actionRegistry: deployment.actionRegistryAddress,
      token: deployment.tokenAddress,
      rwaEligible: true,
      state: fixture.state,
      proposalKind: 1,
      proposalEta: fixture.state === 5 ? fixture.eta : 0n,
      hashProposal: proposalId,
      balanceOf: fixture.balance,
    };
    return values[input.functionName];
  },
  simulateContract: async () => {
    fixture.events.push("simulate");
    fixture.simulations++;
    if (fixture.mode === "hold-simulate") await hold();
    if (fixture.mode === "reorg-final" && fixture.simulations >= 2)
      fixture.observationHash = h("9");
    return { request: { TEST_ONLY: true } };
  },
  getTransaction: async (input: { hash: Hash }) => {
    const call = originalCall();
    return {
      hash: input.hash,
      chainId: 560048,
      from: call.account,
      to: call.address,
      input: call.input,
      value: 0n,
      nonce: 9,
    };
  },
  waitForTransactionReceipt: async (input: {
    hash: Hash;
    onReplaced?: (v: unknown) => void;
  }) => {
    fixture.events.push("receipt");
    fixture.receipts++;
    if (fixture.mode === "unknown-receipt")
      throw Error("TEST_ONLY unresolved receipt");
    if (fixture.mode === "hold-receipt") await hold();
    const receipt = {
      status: "success",
      transactionHash: tx,
      blockNumber: 120n,
      blockHash: h("f"),
      logs: [],
    };
    if (fixture.mode === "repriced") {
      const next = { ...receipt, transactionHash: replacement };
      input.onReplaced?.({ reason: "repriced", transactionReceipt: next });
      return next;
    }
    return receipt;
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
export function useChainId() {
  return useAccount().chainId;
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
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
      account: Address;
      chainId: number;
    }) => {
      fixture.events.push("wallet");
      const call = {
        address: input.address,
        input: encodeFunctionData(
          input as Parameters<typeof encodeFunctionData>[0],
        ),
        functionName: input.functionName,
        account: input.account,
        chainId: input.chainId,
        state: fixture.state,
        balance: String(fixture.balance),
        simulations: fixture.simulations,
      };
      fixture.writes.push(call);
      if (fixture.mode === "reject-wallet")
        throw Object.assign(Error("TEST_ONLY wallet rejected"), { code: 4001 });
      if (fixture.mode === "hold-wallet") await hold();
      sessionStorage.setItem("TEST_ONLY-dao-wallet-call", JSON.stringify(call));
      return tx;
    },
  };
}
