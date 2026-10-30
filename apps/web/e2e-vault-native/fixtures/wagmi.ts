import { useSyncExternalStore } from "react";
import {
  encodeAbiParameters,
  encodeFunctionData,
  type Abi,
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
  canonicalReads: 0,
  transactionReads: 0,
  releaseReceipt: () => releaseReceipt?.(),
  changedSupply: false,
  changedEvent: false,
  setWallet(chainId: number, connected = true) {
    wallet = { address: owner, chainId, isConnected: connected };
    listeners.forEach((fn) => fn());
  },
  releaseWallet() {
    release?.(lastSubmittedHash);
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
// TEST_ONLY synthetic transactions are stored separately from the application journal
// so a reload can read original evidence without manufacturing another wallet write.
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const wrongBlock = `0x${"cd".repeat(32)}` as Hex;
const transactionReads = new Map<string, number>();
let lastSubmittedHash = `0x${"b".repeat(64)}` as Hex;
let releaseReceipt: (() => void) | undefined;
type StoredTransaction = {
  hash: Hex;
  from: Address;
  to: Address;
  input: Hex;
  value: string;
  nonce: number;
  chainId: number;
  blockHash: Hex;
  functionName: string;
};
const txKey = (hash: Hex) => "TEST_ONLY:vault:transaction:" + hash;
function readTransaction(hash: Hex): StoredTransaction {
  const value = sessionStorage.getItem(txKey(hash));
  if (!value) throw Error("TEST_ONLY transaction absent");
  return JSON.parse(value);
}
export function useWriteContract() {
  return {
    writeContractAsync: async (input: {
      functionName: string;
      address: Address;
      args?: unknown[];
      abi: Abi;
      value?: bigint;
      chainId: number;
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
      const nonce =
        Number(sessionStorage.getItem("TEST_ONLY:vault:nonce") || "0") + 1;
      sessionStorage.setItem("TEST_ONLY:vault:nonce", String(nonce));
      const hash = `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
      const transaction: StoredTransaction = {
        hash,
        from: owner,
        to: input.address,
        input: encodeFunctionData({
          abi: input.abi,
          functionName: input.functionName,
          args: input.args,
        }),
        value: String(input.value || 0n),
        nonce,
        chainId: input.chainId,
        blockHash,
        functionName: input.functionName,
      };
      sessionStorage.setItem(txKey(hash), JSON.stringify(transaction));
      lastSubmittedHash = hash;
      if (fixture.mode === "wallet-pending")
        return new Promise<Hex>((resolve) => {
          release = resolve;
        });
      return hash;
    },
  };
}

const client = {
  async getChainId() {
    return fixture.mode === "wrong-chain" ? 1 : 560048;
  },
  async getTransaction({ hash }: { hash: Hex }) {
    fixture.transactionReads++;
    if (fixture.mode === "missing-original")
      throw Error("TEST_ONLY absent transaction");
    const stored = readTransaction(hash);
    const reads = (transactionReads.get(hash) || 0) + 1;
    transactionReads.set(hash, reads);
    return {
      ...stored,
      value: BigInt(stored.value),
      blockNumber: 12n,
      ...(fixture.mode === "wrong-nonce" && reads > 1
        ? { nonce: stored.nonce + 1 }
        : {}),
    };
  },
  async getBlock() {
    fixture.canonicalReads++;
    return {
      number: 12n,
      hash:
        fixture.mode === "reorg" ||
        fixture.mode === "reorg-revert" ||
        (fixture.mode === "second-reorg" && fixture.canonicalReads % 2 === 0)
          ? wrongBlock
          : blockHash,
    };
  },
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
  async waitForTransactionReceipt({
    hash,
    onReplaced,
  }: {
    hash: Hex;
    onReplaced?: (value: unknown) => void;
  }) {
    fixture.receipts++;
    if (fixture.mode === "receipt-pending")
      throw Error("TEST_ONLY receipt unavailable");
    const resolve = () => {
      const original = readTransaction(hash);
      const call = original.functionName;
      const reverted =
        fixture.mode === "revert" || fixture.mode === "reorg-revert";
      if (!reverted) {
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
      }
      let transactionHash = hash;
      if (
        ["repriced", "changed-reprice", "cancelled", "replaced"].includes(
          fixture.mode,
        )
      ) {
        transactionHash =
          `0x${(original.nonce + 1000).toString(16).padStart(64, "0")}` as Hex;
        sessionStorage.setItem(
          txKey(transactionHash),
          JSON.stringify({
            ...original,
            hash: transactionHash,
            ...(fixture.mode === "changed-reprice" ||
            fixture.mode === "cancelled" ||
            fixture.mode === "replaced"
              ? { input: "0xabcd" }
              : {}),
          }),
        );
        onReplaced?.({
          reason:
            fixture.mode === "cancelled"
              ? "cancelled"
              : fixture.mode === "replaced"
                ? "replaced"
                : "repriced",
          transactionReceipt: { transactionHash },
        });
      }
      if (fixture.mode === "wrong-receipt-hash")
        transactionHash = `0x${"ef".repeat(32)}`;
      return {
        transactionHash,
        status: reverted
          ? "reverted"
          : fixture.mode === "unknown-status"
            ? "pending"
            : "success",
        blockHash,
        blockNumber: 12n,
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
    };
    if (fixture.mode === "receipt-deferred")
      return new Promise<ReturnType<typeof resolve>>((done) => {
        releaseReceipt = () => {
          releaseReceipt = undefined;
          done(resolve());
        };
      });
    return resolve();
  },
};
export function usePublicClient() {
  return client;
}
export const addresses = { owner, collection, factory, vault, fraction, other };
