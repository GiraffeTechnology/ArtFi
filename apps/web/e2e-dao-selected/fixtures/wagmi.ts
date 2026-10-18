import { useSyncExternalStore } from "react";
import {
  createDaoSelectedFixture,
  address,
  hash,
  deployment,
} from "../../test-fixtures/dao-selected";
const f = createDaoSelectedFixture();
let account = {
  address: address("6"),
  chainId: 560048,
  status: "connected" as const,
  isConnected: true,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => account;
const refetch = async () => ({});
export const fixture = {
  ...f,
  deployment,
  writes: [] as Record<string, unknown>[],
  switchWallet() {
    account = { ...account, address: address("7") };
    listeners.forEach((x) => x());
  },
  context() {
    return [
      560048,
      account.address.toLowerCase(),
      true,
      deployment.governorAddress,
      deployment.tokenAddress,
      deployment.actionRegistryAddress,
      deployment.vaultAddress,
    ].join(":");
  },
  holdSimulation() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.controls.onSimulation = () => held;
    return release;
  },
};
export function useAccount() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function useChainId() {
  return 560048;
}
export function usePublicClient() {
  return f.client;
}
export function useReadContract(input: { functionName: string }) {
  // The visible membership may be stale; the production preflight must use the reader again.
  const values: Record<string, unknown> = {
    balanceOf: 10n,
    getVotes: 10n,
    totalSupply: 100n,
    proposalThreshold: 1n,
    rwaEligible: true,
    state: f.controls.state,
    proposalKind: 1,
    proposalVotes: [0n, 90n, 0n],
    requiredForVotes: 50n,
  };
  return { data: values[input.functionName], isSuccess: true, refetch };
}
export function useSignMessage() {
  return { isPending: false, signMessageAsync: async () => "0x00" };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (request: Record<string, unknown>) => {
      fixture.writes.push(request);
      return hash("f");
    },
  };
}
