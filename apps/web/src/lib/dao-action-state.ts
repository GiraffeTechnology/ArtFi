import {
  encodeAbiParameters,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  confirmMarketReceipt,
  MarketReceiptFinalError,
} from "./market-transaction";

export type ProposalPackage = {
  calldatas: readonly [Hex];
  description: string;
  descriptionHash: Hex;
  proposalId: bigint;
  targets: readonly [Address];
  values: readonly [bigint];
};
export type DaoTransaction = {
  hash: Hash;
  success: string;
  proposalCreation?: boolean;
  phase: "pending" | "confirmed" | "failed" | "unknown";
  error?: string;
};
export type SubmittedDaoProposal = {
  proposal: ProposalPackage;
  transactionHash: Hash;
};
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const maxSavedLength = 48_000;

export function proposalPackageId(
  proposal: Omit<ProposalPackage, "proposalId" | "description">,
) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { type: "address[]" },
          { type: "uint256[]" },
          { type: "bytes[]" },
          { type: "bytes32" },
        ],
        [
          proposal.targets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash,
        ],
      ),
    ),
  );
}

/** One submitted package per wallet/deployment in this tab; never a signature or draft. */
export function saveSubmittedDaoProposal(
  storage: Pick<Storage, "setItem">,
  context: string,
  saved: SubmittedDaoProposal,
) {
  const serialized = JSON.stringify({ version: 1, ...saved }, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  if (serialized.length > maxSavedLength)
    throw new Error("The proposal package is too large for browser recovery.");
  storage.setItem(`artfi:dao-proposal:${context}`, serialized);
}

export function loadSubmittedDaoProposal(
  storage: Pick<Storage, "getItem">,
  context: string,
  actionRegistry: Address,
): SubmittedDaoProposal | undefined {
  const raw = storage.getItem(`artfi:dao-proposal:${context}`);
  if (!raw) return undefined;
  try {
    if (raw.length > maxSavedLength) throw new Error();
    const saved = JSON.parse(raw);
    const p = saved.proposal;
    if (
      saved.version !== 1 ||
      !hashPattern.test(saved.transactionHash) ||
      typeof p?.description !== "string" ||
      p.description.length < 12 ||
      p.description.length > 1000 ||
      !hashPattern.test(p.descriptionHash) ||
      keccak256(stringToHex(p.description)) !== p.descriptionHash ||
      !Array.isArray(p.targets) ||
      p.targets.length !== 1 ||
      !isAddress(p.targets[0]) ||
      p.targets[0].toLowerCase() !== actionRegistry.toLowerCase() ||
      !Array.isArray(p.values) ||
      p.values.length !== 1 ||
      p.values[0] !== "0" ||
      !Array.isArray(p.calldatas) ||
      p.calldatas.length !== 1 ||
      typeof p.calldatas[0] !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2}){4,16000}$/.test(p.calldatas[0]) ||
      typeof p.proposalId !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(p.proposalId)
    )
      throw new Error();
    const proposal: ProposalPackage = {
      ...p,
      values: [0n],
      proposalId: BigInt(p.proposalId),
    };
    if (proposalPackageId(proposal) !== proposal.proposalId) throw new Error();
    return { proposal, transactionHash: saved.transactionHash };
  } catch {
    throw new Error(
      "The saved proposal package is invalid and was not restored.",
    );
  }
}

export async function checkDaoTransaction({
  client,
  transaction,
  isCurrent,
  update,
  onHash,
}: {
  client: Pick<PublicClient, "waitForTransactionReceipt">;
  transaction: DaoTransaction;
  isCurrent: () => boolean;
  update: (transaction: DaoTransaction) => void;
  onHash?: (hash: Hash) => void;
}) {
  let current = {
    ...transaction,
    phase: "pending" as DaoTransaction["phase"],
    error: undefined as string | undefined,
  };
  const publish = () => {
    if (isCurrent()) update(current);
  };
  publish();
  try {
    const receipt = await confirmMarketReceipt(client, current.hash, (hash) => {
      current = { ...current, hash };
      onHash?.(hash);
      publish();
    });
    current = { ...current, hash: receipt.transactionHash, phase: "confirmed" };
  } catch (error) {
    current = {
      ...current,
      phase: error instanceof MarketReceiptFinalError ? "failed" : "unknown",
      error:
        error instanceof Error
          ? error.message
          : "The transaction receipt is unavailable.",
    };
  }
  publish();
  return current;
}

type DaoSessionSnapshot = {
  busy: boolean;
  awaitingWallet: boolean;
  transaction?: DaoTransaction;
  submitted?: SubmittedDaoProposal;
  recoveryNotice: string;
  actionError: string;
};
const emptyDaoSession: DaoSessionSnapshot = {
  busy: false,
  awaitingWallet: false,
  recoveryNotice: "",
  actionError: "",
};
type ProposalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PendingDaoRequest = {
  version: 1;
  requestId: string;
  hash?: Hash;
  proposalCreation?: boolean;
};
const pendingKey = (context: string) => `artfi:dao-pending:${context}`;
const unknownWalletNotice =
  "A previous wallet request has no known transaction hash. Check the wallet’s activity. This page cannot safely resolve that request, so new DAO writes remain blocked.";

function readPendingDaoRequest(
  storage: ProposalStorage,
  context: string,
): PendingDaoRequest | undefined {
  const raw = storage.getItem(pendingKey(context));
  if (!raw) return;
  if (raw.length > 1024)
    throw new Error(
      "The saved DAO request is invalid. Check the wallet before continuing.",
    );
  const saved = JSON.parse(raw);
  if (
    saved.version !== 1 ||
    typeof saved.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(saved.requestId) ||
    (saved.hash !== undefined &&
      (typeof saved.hash !== "string" || !hashPattern.test(saved.hash))) ||
    (saved.proposalCreation !== undefined &&
      typeof saved.proposalCreation !== "boolean")
  )
    throw new Error(
      "The saved DAO request is invalid. Check the wallet before continuing.",
    );
  return saved;
}

/** A recognized wallet refusal proves that the prompt was declined, unlike a network error. */
export function isDaoWalletRejection(error: unknown) {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    const value = current as { code?: number; name?: string; cause?: unknown };
    if (value.code === 4001 || value.name === "UserRejectedRequestError")
      return true;
    current = value.cause;
  }
  return false;
}

/** Tab-memory coordination plus only the current unresolved public request and last package. */
export function createDaoActionSession(context: string) {
  let snapshot = emptyDaoSession;
  let generation = 0;
  let operation: number | undefined;
  let requestId: string | undefined;
  let restored = false;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<DaoSessionSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };
  const isCurrent = (lease: number) =>
    operation === lease && generation === lease;
  function persistPackage(
    submitted: SubmittedDaoProposal,
    storage: () => ProposalStorage,
  ) {
    try {
      saveSubmittedDaoProposal(storage(), context, submitted);
      return "This tab retains the submitted execution package across reloads.";
    } catch {
      return "Proposal submitted, but this browser could not save its execution package. Keep this tab open to use it.";
    }
  }
  function persistHash(
    transaction: DaoTransaction,
    storage: () => ProposalStorage,
  ) {
    try {
      const target = storage();
      const prior = readPendingDaoRequest(target, context);
      if (!requestId && !prior) requestId = crypto.randomUUID();
      else if (!requestId || prior?.requestId !== requestId)
        return "different" as const;
      target.setItem(
        pendingKey(context),
        JSON.stringify({
          version: 1,
          requestId,
          hash: transaction.hash,
          proposalCreation: transaction.proposalCreation,
        }),
      );
      return "saved" as const;
    } catch {
      return "unavailable" as const;
    }
  }
  function clearOwnedRequest(storage: () => ProposalStorage) {
    const target = storage();
    const prior = readPendingDaoRequest(target, context);
    if (prior && prior.requestId !== requestId)
      throw new Error(
        "A different unresolved DAO request is saved. Check the wallet before continuing.",
      );
    target.removeItem(pendingKey(context));
    requestId = undefined;
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => emptyDaoSession,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isCurrent,
    restore(storage: () => ProposalStorage, actionRegistry: Address) {
      if (restored) return;
      restored = true;
      // A remounted screen must never replace live memory with an older disk snapshot.
      if (
        operation !== undefined ||
        snapshot.transaction ||
        snapshot.submitted ||
        snapshot.awaitingWallet
      )
        return;
      try {
        const target = storage();
        const pending = readPendingDaoRequest(target, context);
        if (pending) {
          requestId = pending.requestId;
          publish(
            pending.hash
              ? {
                  transaction: {
                    hash: pending.hash,
                    phase: "unknown",
                    success:
                      "Saved transaction confirmed. Review on-chain state before continuing.",
                    proposalCreation: pending.proposalCreation,
                  },
                  recoveryNotice:
                    "An unresolved DAO transaction was restored. Check its confirmation before another write.",
                }
              : { awaitingWallet: true, recoveryNotice: unknownWalletNotice },
          );
        }
        const saved = loadSubmittedDaoProposal(target, context, actionRegistry);
        if (saved)
          publish({
            submitted: saved,
            ...(!pending
              ? {
                  recoveryNotice:
                    "Restored this tab's last submitted proposal package. Check its transaction before continuing.",
                  transaction: {
                    hash: saved.transactionHash,
                    phase: "unknown" as const,
                    success:
                      "Saved transaction confirmed. Review the proposal’s on-chain state before continuing.",
                    proposalCreation: true,
                  },
                }
              : {}),
          });
      } catch (error) {
        // Unreadable storage must not make an interrupted request appear cancelled.
        publish({
          awaitingWallet: !snapshot.transaction,
          recoveryNotice:
            error instanceof Error
              ? error.message
              : "Browser DAO recovery is unavailable. Check the wallet before continuing.",
        });
      }
    },
    begin(checking = false): number | undefined {
      if (
        operation !== undefined ||
        snapshot.awaitingWallet ||
        (!checking &&
          (snapshot.transaction?.phase === "pending" ||
            snapshot.transaction?.phase === "unknown"))
      )
        return undefined;
      operation = ++generation;
      publish({
        busy: true,
        actionError: "",
        transaction: checking ? snapshot.transaction : undefined,
      });
      return operation;
    },
    awaitWallet(lease: number, storage: () => ProposalStorage) {
      if (!isCurrent(lease)) return false;
      // Storage must be available before a write can outlive this document.
      const target = storage();
      if (readPendingDaoRequest(target, context))
        throw new Error(
          "An unresolved DAO request is already saved. Check the wallet before continuing.",
        );
      requestId = crypto.randomUUID();
      target.setItem(
        pendingKey(context),
        JSON.stringify({ version: 1, requestId }),
      );
      publish({
        awaitingWallet: true,
        recoveryNotice:
          "Waiting for the wallet response. Leaving or reloading does not cancel this request.",
      });
      return true;
    },
    broadcast(
      lease: number,
      transaction: DaoTransaction,
      proposal: ProposalPackage | undefined,
      storage: () => ProposalStorage,
    ) {
      if (!isCurrent(lease) || snapshot.transaction || !snapshot.awaitingWallet)
        return false;
      const savedHash = persistHash(transaction, storage);
      if (savedHash === "different") {
        publish({
          awaitingWallet: true,
          recoveryNotice:
            "A different unresolved DAO request is saved. This older result did not overwrite it; new writes remain blocked.",
        });
        return false;
      }
      const submitted = proposal
        ? { proposal, transactionHash: transaction.hash }
        : undefined;
      const packageNotice =
        submitted && savedHash === "saved"
          ? persistPackage(submitted, storage)
          : "The unresolved transaction hash is retained in this tab until its receipt is checked.";
      publish({
        transaction,
        awaitingWallet: false,
        recoveryNotice:
          savedHash === "saved"
            ? packageNotice
            : "The transaction was broadcast, but its hash could not be saved. Keep this tab open; reloading will retain only the unresolved wallet-request warning.",
        ...(submitted ? { submitted } : {}),
      });
      return true;
    },
    replaceHash(
      lease: number,
      expectedHash: Hash,
      hash: Hash,
      storage: () => ProposalStorage,
    ) {
      if (!isCurrent(lease) || snapshot.transaction?.hash !== expectedHash)
        return false;
      const transaction = { ...snapshot.transaction, hash };
      const savedHash = persistHash(transaction, storage);
      if (savedHash === "different") {
        publish({
          awaitingWallet: true,
          recoveryNotice:
            "A different unresolved DAO request is saved. This older result did not overwrite it; new writes remain blocked.",
        });
        return false;
      }
      const submitted =
        snapshot.transaction.proposalCreation &&
        snapshot.submitted?.transactionHash === expectedHash
          ? { ...snapshot.submitted, transactionHash: hash }
          : undefined;
      const packageNotice =
        submitted && savedHash === "saved"
          ? persistPackage(submitted, storage)
          : snapshot.recoveryNotice;
      publish({
        transaction,
        recoveryNotice:
          savedHash === "saved"
            ? packageNotice
            : "The replacement transaction hash could not be saved. Keep this tab open to confirm it.",
        ...(submitted ? { submitted } : {}),
      });
      return true;
    },
    updateTransaction(
      lease: number,
      expectedHash: Hash,
      transaction: DaoTransaction,
      storage: () => ProposalStorage,
    ) {
      if (
        !isCurrent(lease) ||
        snapshot.transaction?.hash !== expectedHash ||
        transaction.hash !== expectedHash
      )
        return false;
      if (transaction.phase === "confirmed" || transaction.phase === "failed") {
        try {
          clearOwnedRequest(storage);
        } catch (error) {
          publish({
            transaction,
            awaitingWallet: true,
            recoveryNotice:
              error instanceof Error
                ? error.message
                : "The saved request could not be cleared. New writes remain blocked.",
          });
          return true;
        }
      }
      publish({ transaction });
      return true;
    },
    fail(
      lease: number,
      actionError: string,
      rejected: boolean,
      storage: () => ProposalStorage,
    ) {
      if (!isCurrent(lease)) return;
      if (snapshot.awaitingWallet && rejected && !snapshot.transaction) {
        try {
          clearOwnedRequest(storage);
          publish({
            awaitingWallet: false,
            recoveryNotice:
              "The wallet request was declined. No broadcast was recorded.",
          });
        } catch {
          /* Keep the unresolved marker if its ownership or removal is uncertain. */
        }
      }
      publish({
        actionError,
        ...(snapshot.awaitingWallet
          ? { recoveryNotice: unknownWalletNotice }
          : {}),
      });
    },
    finish(lease: number) {
      if (!isCurrent(lease)) return;
      operation = undefined;
      publish({ busy: false });
    },
  };
}

const daoActionSessions = new Map<
  string,
  ReturnType<typeof createDaoActionSession>
>();

/** Wallet, chain and every deployment address are part of the caller's context key. */
export function daoActionSession(context: string) {
  let session = daoActionSessions.get(context);
  if (!session) {
    session = createDaoActionSession(context);
    daoActionSessions.set(context, session);
  }
  return session;
}
