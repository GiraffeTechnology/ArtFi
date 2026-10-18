import { useSyncExternalStore } from "react";
import {
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { artFiVaultAbi } from "../../src/lib/contracts";
import type { VaultSetup } from "../../src/lib/vault-setup";
export const owner = "0x1000000000000000000000000000000000000001" as Address;
export const collection =
  "0x1000000000000000000000000000000000000002" as Address;
export const factory = "0x1000000000000000000000000000000000000003" as Address;
export const vault = "0x1000000000000000000000000000000000000004" as Address;
export const fraction = "0x1000000000000000000000000000000000000005" as Address;
const other = "0x1000000000000000000000000000000000000006" as Address;
const requestId = `0x${"a".repeat(64)}` as Hex;
const topics = encodeEventTopics({
  abi: artFiVaultAbi,
  eventName: "Fractionalized",
  args: { token: fraction, recipient: owner },
});
export const setup = (stage: VaultSetup["stage"]): VaultSetup => ({
  chainId: 560048,
  walletAddress: owner,
  factoryAddress: factory,
  idempotencyKey: "test-only-vault-request-20261019",
  stage,
  vaultAddress: stage === "configure" ? undefined : vault,
  configuration: {
    collectionAddress: collection,
    tokenId: "7",
    vaultName: "TEST_ONLY asset DAO",
    adminAddress: owner,
    pauserAddress: owner,
    fractionalizerAddress: owner,
    tokenName: "TEST_ONLY Fraction",
    tokenSymbol: "TEST",
    tokenSupply: "100000000000000000000",
    recipient: owner,
  },
  intent: {
    intentId: "test-only-intent",
    requestId,
    factoryAddress: factory,
    collectionAddress: collection,
    tokenId: "7",
    vaultName: "TEST_ONLY asset DAO",
    adminAddress: owner,
    pauserAddress: owner,
    fractionalizerAddress: owner,
    chainId: 560048,
  },
});
const listeners = new Set<() => void>();
let wallet = { address: owner, chainId: 560048, isConnected: true };
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
let release: ((hash: Hex) => void) | undefined;
export const fixture = {
  stage: "created",
  mode: "success",
  ownerOverride: "",
  roleAllowed: true,
  requestVault: vault as string,
  calls: [] as { functionName: string; address: string; args: unknown[] }[],
  signs: 0,
  receipts: 0,
  changedSupply: false,
  changedEvent: false,
  setWallet(chainId: number, connected = true) {
    wallet = { address: owner, chainId, isConnected: connected };
    listeners.forEach((fn) => fn());
  },
  releaseWallet() {
    release?.(`0x${"b".repeat(64)}`);
    release = undefined;
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
  return useAccount().chainId;
}
export function useSignMessage() {
  return {
    signMessageAsync: async () => {
      fixture.signs++;
      throw Error("Unexpected TEST_ONLY operator signature");
    },
  };
}
export function useWriteContract() {
  return {
    writeContractAsync: async (input: {
      functionName: string;
      address: string;
      args?: unknown[];
    }) => {
      fixture.calls.push({
        functionName: input.functionName,
        address: input.address,
        args: input.args || [],
      });
      if (fixture.mode === "reject")
        throw Object.assign(new Error("TEST_ONLY wallet rejected"), {
          code: 4001,
        });
      if (fixture.mode === "wallet-pending")
        return new Promise<Hex>((resolve) => {
          release = resolve;
        });
      return `0x${"b".repeat(64)}` as Hex;
    },
  };
}
const client = {
  async readContract(input: { functionName: string }) {
    const f = input.functionName;
    if (f === "vaultForRequest") return fixture.requestVault;
    if (f === "vaultByAsset") return vault;
    if (f === "collection") return collection;
    if (f === "tokenId") return 7n;
    if (f === "tokenAdmin" || f === "originalOwner") return owner;
    if (f === "vaultName") return "TEST_ONLY asset DAO";
    if (f.endsWith("_ROLE")) return requestId;
    if (f === "hasRole") return fixture.roleAllowed;
    if (f === "ownerOf")
      return (
        fixture.ownerOverride ||
        (["deposited", "complete"].includes(fixture.stage) ? vault : owner)
      );
    if (f === "getApproved")
      return ["approved", "deposited", "complete"].includes(fixture.stage)
        ? vault
        : zeroAddress;
    if (f === "deposited")
      return ["deposited", "complete"].includes(fixture.stage);
    if (f === "fractionalToken")
      return fixture.stage === "complete" ? fraction : zeroAddress;
    if (f === "fractionalSupply")
      return fixture.changedSupply ? 1n : 100000000000000000000n;
    if (f === "paused") return false;
    throw Error("Unexpected TEST_ONLY contract read: " + f);
  },
  async waitForTransactionReceipt({ hash }: { hash: Hex }) {
    fixture.receipts++;
    if (fixture.mode === "receipt-pending")
      throw Error("TEST_ONLY receipt unavailable");
    if (fixture.mode === "revert")
      return { transactionHash: hash, status: "reverted", logs: [] };
    const call = fixture.calls.at(-1)?.functionName;
    fixture.stage =
      call === "createVault"
        ? "created"
        : call === "approve"
          ? "approved"
          : call === "deposit"
            ? "deposited"
            : call === "fractionalize"
              ? "complete"
              : fixture.stage;
    return {
      transactionHash: hash,
      status: "success",
      logs:
        fixture.stage === "complete"
          ? [
              {
                address: vault,
                topics: fixture.changedEvent ? [] : topics,
                data: encodeAbiParameters(
                  [{ type: "uint256" }],
                  [100000000000000000000n],
                ),
              },
            ]
          : [],
    };
  },
};
export function usePublicClient() {
  return client;
}
export const addresses = { owner, collection, factory, vault, fraction, other };
