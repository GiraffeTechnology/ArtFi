import { isAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { erc721VaultApprovalAbi } from "./contracts";
import { setupRecoverySnapshot, type SetupRecord } from "./setup-recovery";
import {
  isVaultSetup,
  recoverCreatedVault,
  vaultRecoveryAbi,
  type VaultSetup,
} from "./vault-setup";

type Store = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
export type VaultContinuation = {
  version: 1;
  data: VaultSetup;
  participants: Address[];
};
const prefix = "artfi:vault-continuation:560048:";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const context = (wallet: Address) => `vault:560048:${wallet.toLowerCase()}`;
const key = (data: VaultSetup) =>
  `${prefix}${data.factoryAddress.toLowerCase()}:${data.vaultAddress!.toLowerCase()}`;
function valid(value: unknown): value is VaultContinuation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as VaultContinuation;
  return (
    candidate.version === 1 &&
    isVaultSetup(candidate.data) &&
    candidate.data.stage !== "configure" &&
    Boolean(candidate.data.vaultAddress) &&
    Array.isArray(candidate.participants) &&
    candidate.participants.length > 0 &&
    candidate.participants.every(
      (wallet) => typeof wallet === "string" && isAddress(wallet),
    )
  );
}
export function sameVaultAsset(a: VaultSetup, b: VaultSetup) {
  return (
    a.chainId === b.chainId &&
    same(a.factoryAddress, b.factoryAddress) &&
    same(
      a.configuration.collectionAddress,
      b.configuration.collectionAddress,
    ) &&
    a.configuration.tokenId === b.configuration.tokenId
  );
}
export function readVaultContinuation(storage: Store, data: VaultSetup) {
  const raw = storage.getItem(key(data));
  if (!raw) return;
  if (raw.length > 32_000)
    throw new Error("The saved Vault continuation is invalid.");
  const parsed: unknown = JSON.parse(raw);
  if (
    !valid(parsed) ||
    !sameVaultAsset(parsed.data, data) ||
    !same(parsed.data.vaultAddress!, data.vaultAddress!)
  )
    throw new Error("The saved Vault continuation does not match this asset.");
  return parsed;
}
export function listVaultContinuations(storage: Store) {
  const results: VaultContinuation[] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(prefix)) continue;
    const raw = storage.getItem(name);
    if (!raw || raw.length > 32_000) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (valid(parsed) && name === key(parsed.data)) results.push(parsed);
    } catch {
      /* A damaged discovery entry never authorizes a continuation. */
    }
  }
  return results;
}
/** Public, confirmed configuration only. Each wallet keeps its own unresolved request journal. */
export function saveVaultContinuation(
  storage: Store,
  record: SetupRecord<VaultSetup>,
) {
  if (
    record.pending ||
    !isVaultSetup(record.data) ||
    record.data.stage === "configure" ||
    !record.data.vaultAddress
  )
    throw new Error(
      "Only a confirmed Vault with no unresolved request can be saved for continuation.",
    );
  const previous = readVaultContinuation(storage, record.data);
  const rank = {
    configure: 0,
    created: 1,
    approved: 2,
    deposited: 3,
    complete: 4,
  };
  const data =
    previous && rank[previous.data.stage] > rank[record.data.stage]
      ? {
          ...previous.data,
          ...(previous.data.creationHash === record.data.creationHash
            ? { submissionPending: record.data.submissionPending }
            : {}),
        }
      : { ...record.data };
  const participants = [
    ...new Map(
      [...(previous?.participants ?? []), record.data.walletAddress].map(
        (wallet) => [wallet.toLowerCase(), wallet],
      ),
    ).values(),
  ];
  const result: VaultContinuation = { version: 1, data, participants };
  storage.setItem(key(data), JSON.stringify(result));
  return result;
}

/** Recheck after async reads and immediately before a wallet prompt, including late in-memory hashes. */
export function assertVaultParticipantsReady(
  storage: Store,
  data: VaultSetup,
  currentWallet?: Address,
) {
  const saved = readVaultContinuation(storage, data);
  if (!saved)
    throw new Error(
      "The confirmed Vault continuation could not be read. Check its original wallet journal before continuing.",
    );
  for (const wallet of saved.participants) {
    const recordContext = context(wallet);
    const live = setupRecoverySnapshot<VaultSetup>(recordContext);
    if (
      live?.blocked ||
      (live?.record &&
        sameVaultAsset(live.record.data, data) &&
        (live.record.pending ||
          (live.busy && (!currentWallet || !same(wallet, currentWallet)))))
    )
      throw new Error(
        "A wallet still has an unresolved operation for this Vault. Check that original wallet's transaction first.",
      );
    const raw = storage.getItem(`artfi:setup:${recordContext}`);
    if (!raw || raw.length > 32_000)
      throw new Error(
        "A participating wallet journal is missing. Missing data does not cancel its wallet request.",
      );
    const parsed = JSON.parse(raw) as SetupRecord<VaultSetup> & {
      version?: number;
    };
    if (
      parsed.version !== 1 ||
      !isVaultSetup(parsed.data) ||
      !same(parsed.data.walletAddress, wallet)
    )
      throw new Error("A participating wallet journal could not be verified.");
    if (sameVaultAsset(parsed.data, data) && parsed.pending)
      throw new Error(
        "A wallet still has an unresolved operation for this Vault. Check that original wallet's transaction first.",
      );
  }
}

/** Explicit handoff validates current custody and actual Vault role; it grants no registrar permission. */
export async function reviewVaultContinuation(
  client: Pick<PublicClient, "readContract">,
  saved: VaultContinuation,
  wallet: Address,
) {
  if (!valid(saved) || !["deposited", "complete"].includes(saved.data.stage))
    throw new Error(
      "Only a confirmed deposited or completed Vault can be restored.",
    );
  const data = saved.data;
  const vault = await recoverCreatedVault(client, data);
  const [deposited, owner, originalOwner, token, role, supply] =
    await Promise.all([
      client.readContract({
        abi: vaultRecoveryAbi,
        address: vault,
        functionName: "deposited",
      }),
      client.readContract({
        abi: erc721VaultApprovalAbi,
        address: data.configuration.collectionAddress,
        functionName: "ownerOf",
        args: [BigInt(data.configuration.tokenId)],
      }),
      client.readContract({
        abi: vaultRecoveryAbi,
        address: vault,
        functionName: "originalOwner",
      }),
      client.readContract({
        abi: vaultRecoveryAbi,
        address: vault,
        functionName: "fractionalToken",
      }),
      client.readContract({
        abi: vaultRecoveryAbi,
        address: vault,
        functionName: "FRACTIONALIZER_ROLE",
      }),
      client.readContract({
        abi: vaultRecoveryAbi,
        address: vault,
        functionName: "fractionalSupply",
      }),
    ]);
  const allowed = await client.readContract({
    abi: vaultRecoveryAbi,
    address: vault,
    functionName: "hasRole",
    args: [role, wallet],
  });
  const depositor = data.depositorAddress ?? data.walletAddress;
  if (
    saved.data.stage === "complete" &&
    deposited &&
    same(owner, vault) &&
    same(originalOwner, depositor) &&
    saved.data.fractionToken &&
    same(token, saved.data.fractionToken) &&
    supply === BigInt(data.configuration.tokenSupply)
  )
    return { ...data, walletAddress: wallet, depositorAddress: depositor };
  if (
    saved.data.stage !== "deposited" ||
    !deposited ||
    !same(owner, vault) ||
    !same(originalOwner, depositor) ||
    !same(token, zeroAddress) ||
    !allowed
  )
    throw new Error(
      "This wallet must hold the Vault FRACTIONALIZER_ROLE, with the original NFT still deposited and no fractions already issued.",
    );
  return {
    ...data,
    walletAddress: wallet,
    depositorAddress: depositor,
    stage: "deposited" as const,
  };
}

export function archiveCompletedVault(
  storage: Store,
  record: SetupRecord<VaultSetup> | undefined,
  busy: boolean,
  blocked: boolean,
) {
  if (
    !record ||
    busy ||
    blocked ||
    record.pending ||
    record.data.stage !== "complete"
  )
    throw new Error(
      "Finish or resolve this Vault before preparing another one.",
    );
  return saveVaultContinuation(storage, record);
}

export function markVaultContinuationLogged(
  storage: Store,
  expected: VaultContinuation,
) {
  const latest = readVaultContinuation(storage, expected.data);
  if (
    !latest ||
    latest.data.intent?.intentId !== expected.data.intent?.intentId ||
    latest.data.creationHash !== expected.data.creationHash
  )
    throw new Error("The saved Vault submission identity changed.");
  const next = {
    ...latest,
    data: { ...latest.data, submissionPending: false },
  };
  storage.setItem(key(next.data), JSON.stringify(next));
  return next;
}
