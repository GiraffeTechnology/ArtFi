"use client";
import { DaoSnapshotWeight } from "./dao-snapshot-weight";

import styles from "./dao-governance.module.css";

import {
  FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  formatUnits,
  isAddress,
  keccak256,
  stringToHex,
} from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignMessage,
  useWriteContract,
} from "wagmi";

import { useUserSession } from "@/components/user-session-provider";
import { DaoAccountMetrics } from "@/components/dao-account-metrics";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import { runDaoSessionAction } from "@/lib/dao-session-action";
import { DaoProposalDraftWorkspace } from "@/components/dao-proposal-draft-workspace";
import type { DaoDraftForm } from "@/lib/dao-proposal-draft";

import {
  daoActionsAbi,
  daoGovernorAbi,
  daoVotingTokenAbi,
} from "@/lib/dao-contracts";
import { supportedChain } from "@/lib/wagmi";
import {
  checkDaoTransaction,
  isDaoCallBinding,
  daoActionSession,
  isDaoWalletRejection,
  type DaoTransaction,
  type ProposalPackage,
} from "@/lib/dao-action-state";

import {
  daoExecutionDeployment,
  publishedDaoReadDeadline,
} from "@/lib/dao-published-execution";
import {
  prepareSelectedDaoAction,
  selectedDaoPackage,
} from "@/lib/dao-selected-execution";

export type DaoDeployment = {
  actionRegistryAddress?: string;
  governorAddress?: string;
  tokenAddress?: string;
  vaultAddress?: string;
};

import { verifyDaoGovernanceAtWallet } from "@/lib/dao-governance-wallet-boundary";

type ActionType = DaoDraftForm["actionType"];

const proposalStates = [
  "Pending",
  "Active",
  "Cancelled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;

const proposalKinds = [
  "Unclassified",
  "Market migration",
  "Physical action",
  "Forced buyout",
];
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;

function shortUnits(value: bigint): string {
  const rendered = formatUnits(value, 18);
  const [whole, fraction = ""] = rendered.split(".");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole;
}

function safeBigInt(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

export function DaoGovernance({ deployment }: { deployment: DaoDeployment }) {
  const { address, isConnected } = useAccount();
  const auth = useUserSession();
  const chainId = useChainId();
  const context = [
    chainId,
    address?.toLowerCase(),
    isConnected,
    deployment.governorAddress?.toLowerCase(),
    deployment.tokenAddress?.toLowerCase(),
    deployment.actionRegistryAddress?.toLowerCase(),
    deployment.vaultAddress?.toLowerCase(),
  ].join(":");
  return (
    <DaoGovernanceSession
      key={`${context}:${auth.session?.id ?? "signed-out"}:${auth.revision}`}
      deployment={deployment}
      context={context}
    />
  );
}

function DaoGovernanceSession({
  deployment,
  context,
}: {
  deployment: DaoDeployment;
  context: string;
}) {
  const configured =
    isAddress(deployment.governorAddress ?? "") &&
    isAddress(deployment.tokenAddress ?? "") &&
    isAddress(deployment.actionRegistryAddress ?? "") &&
    isAddress(deployment.vaultAddress ?? "");
  const governor = (configured ? deployment.governorAddress : undefined) as
    Address | undefined;
  const token = (configured ? deployment.tokenAddress : undefined) as
    Address | undefined;
  const actionRegistry = (
    configured ? deployment.actionRegistryAddress : undefined
  ) as Address | undefined;

  const { address, isConnected, status } = useAccount();
  const auth = useUserSession();
  const chainId = useChainId();
  const authenticated = Boolean(
    portfolioSessionKey(auth, { address, chainId, status }),
  );
  const publicClient = usePublicClient();
  const [verificationNonce, setVerificationNonce] = useState(() =>
    crypto.randomUUID(),
  );
  const [verifiedAddress, setVerifiedAddress] = useState<Address>();
  const [notice, setNotice] = useState("");
  const [proposalInput, setProposalInput] = useState<string>();
  const [actionType, setActionType] = useState<ActionType>("market");
  const [description, setDescription] = useState("");
  const [marketName, setMarketName] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [evidenceURI, setEvidenceURI] = useState("");
  const [amountWei, setAmountWei] = useState("");
  const [t0, setT0] = useState("");
  const [observationStart, setObservationStart] = useState("");
  const [tradeCount, setTradeCount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const session = useMemo(() => daoActionSession(context), [context]);
  const actionState = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const {
    transaction,
    busy: actionBusy,
    recoveryNotice,
    actionError,
  } = actionState;
  const proposalPackage = authenticated
    ? actionState.submitted?.proposal
    : undefined;
  const selectedProposalInput =
    proposalInput ?? proposalPackage?.proposalId.toString() ?? "";
  const selectionGeneration = useRef(0);
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (address && isConnected && actionRegistry)
      session.restore(() => window.sessionStorage, actionRegistry);
  }, [address, isConnected, actionRegistry, session]);

  const enabled =
    configured &&
    Boolean(address) &&
    authenticated &&
    chainId === supportedChain.id;
  const {
    data: balance = 0n,
    isSuccess: balanceKnown,
    refetch: refetchBalance,
  } = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const {
    data: votes = 0n,
    isSuccess: votesKnown,
    refetch: refetchVotes,
  } = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "getVotes",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const { data: totalSupply = 0n, isSuccess: supplyKnown } = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "totalSupply",
    query: { enabled: configured },
  });
  const { data: proposalThreshold = 0n, isSuccess: thresholdKnown } =
    useReadContract({
      chainId: supportedChain.id,
      abi: daoGovernorAbi,
      address: governor,
      functionName: "proposalThreshold",
      query: { enabled: configured },
    });
  const { data: rwaEligible = false } = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "rwaEligible",
    query: { enabled: configured },
  });

  const proposalId = useMemo(
    () => safeBigInt(selectedProposalInput),
    [selectedProposalInput],
  );
  const selectedPackage = authenticated
    ? selectedDaoPackage(actionState.submitted, proposalId)
    : undefined;
  const proposalEnabled = configured && proposalId !== null;
  const { data: proposalState, refetch: refetchProposalState } =
    useReadContract({
      chainId: supportedChain.id,
      abi: daoGovernorAbi,
      address: governor,
      functionName: "state",
      args: [proposalId ?? 0n],
      query: { enabled: proposalEnabled },
    });
  const { data: proposalKind } = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalKind",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const { data: proposalVotes, refetch: refetchProposalVotes } =
    useReadContract({
      chainId: supportedChain.id,
      abi: daoGovernorAbi,
      address: governor,
      functionName: "proposalVotes",
      args: [proposalId ?? 0n],
      query: { enabled: proposalEnabled },
    });
  const { data: requiredForVotes } = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "requiredForVotes",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });

  const {
    data: proposalSnapshot,
    isSuccess: snapshotKnown,
    refetch: refetchSnapshot,
  } = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalSnapshot",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const {
    data: snapshotVotes,
    isSuccess: snapshotVotesKnown,
    refetch: refetchSnapshotVotes,
  } = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "getVotes",
    args: [
      address ?? "0x0000000000000000000000000000000000000000",
      proposalSnapshot ?? 0n,
    ],
    query: {
      enabled:
        enabled && proposalEnabled && snapshotKnown && proposalState === 1,
    },
  });

  const { signMessageAsync, isPending: signaturePending } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const transactionPending =
    actionBusy ||
    actionState.awaitingWallet ||
    transaction?.phase === "pending" ||
    transaction?.phase === "unknown";

  const ownershipMessage = useMemo(
    () =>
      `ArtFi DAO ownership verification\nChain: Hoodi (${supportedChain.id})\nGovernor: ${governor ?? "not-configured"}\nAccount: ${address ?? "not-connected"}\nNonce: ${verificationNonce}\nNo transaction or asset transfer is authorized.`,
    [address, governor, verificationNonce],
  );

  const verified = Boolean(
    isConnected &&
    address &&
    verifiedAddress?.toLowerCase() === address.toLowerCase(),
  );
  const member =
    authenticated && verified && balanceKnown && balance > 0n && rwaEligible;
  const canVote =
    authenticated &&
    verified &&
    rwaEligible &&
    proposalState === 1 &&
    snapshotKnown &&
    snapshotVotesKnown &&
    typeof snapshotVotes === "bigint" &&
    snapshotVotes > 0n;
  const canPropose =
    member &&
    votesKnown &&
    thresholdKnown &&
    votes >= proposalThreshold &&
    proposalThreshold > 0n;
  const correctChain = chainId === supportedChain.id;

  async function runAction(
    action: (lease: number) => Promise<void>,
    checking = false,
  ) {
    if (!active.current) return;
    const lease = session.begin(checking);
    if (lease === undefined) return;
    setNotice("");
    try {
      await action(lease);
    } catch (error) {
      session.fail(
        lease,
        error instanceof Error ? error.message : "The wallet action failed.",
        isDaoWalletRejection(error),
        () => window.sessionStorage,
      );
    } finally {
      session.finish(lease);
    }
  }

  function actionIsCurrent(lease: number) {
    const current = userSessionController.getSnapshot();
    return (
      active.current &&
      session.isCurrent(lease) &&
      current.revision === auth.revision &&
      current.session?.id === auth.session?.id &&
      Boolean(portfolioSessionKey(current, { address, chainId, status }))
    );
  }
  async function verifyOwnership(lease: number) {
    if (!address || !configured || !correctChain || !publicClient) return;
    const signature = await runDaoSessionAction({
      account: address,
      chainId,
      assertSession: assertTradingSession,
      isCurrent: () => actionIsCurrent(lease),
      prepare: async () => {
        if (
          (await publishedDaoReadDeadline(publicClient.getChainId())) !==
          supportedChain.id
        )
          throw Error("The DAO reader is not on Hoodi.");
      },
      execute: () =>
        signMessageAsync({ message: ownershipMessage, account: address }),
    });
    if (!active.current) return;
    const valid = await publishedDaoReadDeadline(
      publicClient.verifyMessage({
        address,
        message: ownershipMessage,
        signature,
      }),
    );
    if (!actionIsCurrent(lease)) return;
    if (!valid) throw new Error("Wallet signature did not verify.");
    setVerifiedAddress(address);
    setVerificationNonce(crypto.randomUUID());
    setNotice(
      "Address control verified for this browser session. The signature was not stored.",
    );
  }

  async function checkReceipt(next: DaoTransaction, lease: number) {
    if (!publicClient || !address || !governor || !token)
      throw new Error(
        "The chain client is unavailable. The transaction is still unconfirmed.",
      );
    let expectedHash = next.hash;
    await checkDaoTransaction({
      client: publicClient,
      binding: {
        chainId: 560048,
        account: address,
        targets: [governor, token],
      },
      transaction: next,
      isCurrent: () => session.isCurrent(lease),
      update: (value) =>
        session.updateTransaction(
          lease,
          expectedHash,
          value,
          () => window.sessionStorage,
        ),
      onHash: (hash) => {
        if (
          session.replaceHash(
            lease,
            expectedHash,
            hash,
            () => window.sessionStorage,
          )
        )
          expectedHash = hash;
      },
    });
  }

  // The mounted subscriber refreshes reads even when an older instance received the receipt.
  useEffect(() => {
    if (transaction?.phase !== "confirmed") return;
    void Promise.all([
      ...(enabled ? [refetchBalance(), refetchVotes()] : []),
      refetchProposalState(),
      refetchProposalVotes(),
      refetchSnapshot(),
      refetchSnapshotVotes(),
    ]);
  }, [
    transaction?.phase,
    transaction?.hash,
    enabled,
    refetchBalance,
    refetchVotes,
    refetchProposalState,
    refetchProposalVotes,
    refetchSnapshot,
    refetchSnapshotVotes,
  ]);

  async function submitWrite(
    request: Parameters<typeof writeContractAsync>[0],
    success: string,
    lease: number,
    submittedPackage?: ProposalPackage,
    verifySelection?: () => Promise<unknown>,
  ) {
    if (!active.current || !session.isCurrent(lease)) return;
    const eligibleForCall =
      request.functionName === "castVote" ? canVote : member;
    if (!eligibleForCall || !correctChain || !address || !publicClient)
      throw new Error("DAO ownership verification on Hoodi is required.");
    const boundRequest = {
      target: request.address,
      input: encodeFunctionData(
        request as Parameters<typeof encodeFunctionData>[0],
      ),
      value: ((request as { value?: bigint }).value ?? 0n).toString(),
    };
    if (!isDaoCallBinding(boundRequest))
      throw Error("The DAO call is invalid or too large for safe recovery.");
    const selectedGeneration = selectionGeneration.current;
    const selectionSensitive = ["castVote", "queue", "execute"].includes(
      request.functionName,
    );
    const verifyBeforeWallet = async () => {
      await publishedDaoReadDeadline(
        verifyDaoGovernanceAtWallet({
          client: publicClient,
          deployment: daoExecutionDeployment(deployment),
          account: address,
          call: boundRequest,
          verifySelection,
          assertCurrent: () => {
            if (
              !actionIsCurrent(lease) ||
              (selectionSensitive &&
                selectedGeneration !== selectionGeneration.current)
            )
              throw Error("The DAO action selection or session changed.");
          },
        }),
      );
    };
    const hash = await runDaoSessionAction({
      account: address,
      chainId,
      assertSession: assertTradingSession,
      isCurrent: () => actionIsCurrent(lease),
      prepare: verifyBeforeWallet,
      execute: async () => {
        await verifyBeforeWallet();

        if (!session.awaitWallet(lease, () => window.sessionStorage))
          return undefined;
        return writeContractAsync({
          ...request,
          account: address,
          chainId: supportedChain.id,
        });
      },
    });
    if (!hash) return;
    // Keep the original operation alive across navigation; a returned view subscribes to it.
    const next: DaoTransaction = {
      hash,
      request: boundRequest,
      success,
      phase: "pending",
      proposalCreation: Boolean(submittedPackage),
    };
    if (
      !session.broadcast(
        lease,
        next,
        submittedPackage,
        () => window.sessionStorage,
      )
    )
      return;
    if (submittedPackage && active.current)
      setProposalInput(submittedPackage.proposalId.toString());
    await checkReceipt(next, lease);
  }

  async function delegateToSelf(lease: number) {
    if (!token || !address) return;
    await submitWrite(
      {
        abi: daoVotingTokenAbi,
        address: token,
        functionName: "delegate",
        args: [address],
      },
      "Delegation confirmed.",
      lease,
    );
  }

  async function castVote(support: 0 | 1 | 2, lease: number) {
    if (!governor || proposalId === null) return;
    await submitWrite(
      {
        abi: daoGovernorAbi,
        address: governor,
        functionName: "castVote",
        args: [proposalId, support],
      },
      "Vote confirmed. The proposal snapshot determines final voting weight.",
      lease,
    );
  }

  function composeAction(): { callData: Hex; kind: 1 | 2 | 3 } {
    if (!actionRegistry)
      throw new Error("DAO action registry is not configured.");
    if (
      !evidenceURI.startsWith("https://") &&
      !evidenceURI.startsWith("ipfs://")
    ) {
      throw new Error("Evidence URI must use HTTPS or IPFS.");
    }

    if (!bytes32Pattern.test(evidenceHash))
      throw new Error("A bytes32 evidence hash is required.");
    const hash = evidenceHash as Hex;

    if (actionType === "market") {
      if (marketName.trim().length < 2)
        throw new Error("Destination market is required.");
      return {
        kind: 1,
        callData: encodeFunctionData({
          abi: daoActionsAbi,
          functionName: "recordMarketMigration",
          args: [keccak256(stringToHex(marketName.trim())), hash, evidenceURI],
        }),
      };
    }

    const physicalActions: Partial<Record<ActionType, number>> = {
      warehouse: 0,
      auction: 1,
      sale: 2,
      custodian: 3,
    };
    const physicalAction = physicalActions[actionType];
    if (physicalAction !== undefined) {
      return {
        kind: 2,
        callData: encodeFunctionData({
          abi: daoActionsAbi,
          functionName: "requestPhysicalAction",
          args: [physicalAction, hash, evidenceURI],
        }),
      };
    }

    if (actionType === "failure") {
      const cost = safeBigInt(amountWei);
      const deadline = safeBigInt(dueDate);
      if (
        cost === null ||
        cost === 0n ||
        deadline === null ||
        deadline > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error("Valid cost and due date are required.");
      return {
        kind: 2,
        callData: encodeFunctionData({
          abi: daoActionsAbi,
          functionName: "recordSharedFailureAssessment",
          args: [cost, Number(deadline), hash, evidenceURI],
        }),
      };
    }

    const price = safeBigInt(amountWei);
    const startTime = safeBigInt(t0);
    const observation = safeBigInt(observationStart);
    const trades = safeBigInt(tradeCount);
    if (
      price === null ||
      price === 0n ||
      startTime === null ||
      startTime > BigInt(Number.MAX_SAFE_INTEGER) ||
      trades === null ||
      trades > 4_294_967_295n ||
      (observation !== null && observation > BigInt(Number.MAX_SAFE_INTEGER))
    ) {
      throw new Error("Valid buyout price, T0 and trade count are required.");
    }
    const thirtyDay = actionType === "buyout30";
    if (
      (thirtyDay && observation === null) ||
      (!thirtyDay && observationStart !== "0")
    ) {
      throw new Error(
        "The pricing observation window does not match the selected rule.",
      );
    }
    return {
      kind: 3,
      callData: encodeFunctionData({
        abi: daoActionsAbi,
        functionName: "initiateForcedBuyout",
        args: [
          {
            unitPriceWei: price,
            t0: Number(startTime),
            observationStart: Number(observation ?? 0n),
            pricingRule: thirtyDay ? 0 : 1,
            tradeCount: Number(trades),
            evidenceHash: hash,
            evidenceURI,
          },
        ],
      }),
    };
  }

  function createProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction(async (lease) => {
      if (!governor || !actionRegistry || !publicClient || !canPropose) return;
      if (description.trim().length < 12)
        throw new Error("A clear proposal description is required.");
      const { callData, kind } = composeAction();
      const targets = [actionRegistry] as const;
      const values = [0n] as const;
      const calldatas = [callData] as const;
      const descriptionHash = keccak256(stringToHex(description.trim()));
      const nextProposalId = await publicClient.readContract({
        abi: daoGovernorAbi,
        address: governor,
        functionName: "hashProposal",
        args: [targets, values, calldatas, descriptionHash],
      });
      if (!active.current) return;
      const nextPackage: ProposalPackage = {
        calldatas,
        description: description.trim(),
        descriptionHash,
        proposalId: nextProposalId,
        targets,
        values,
      };
      await submitWrite(
        {
          abi: daoGovernorAbi,
          address: governor,
          functionName: "proposeWithKind",
          args: [targets, values, calldatas, description.trim(), kind],
        },
        "Proposal creation confirmed.",
        lease,
        nextPackage,
      );
    });
  }

  async function queueOrExecute(mode: "queue" | "execute", lease: number) {
    if (
      !governor ||
      !selectedPackage ||
      !actionState.submitted ||
      !publicClient ||
      !address
    )
      throw new Error("Select the saved proposal package before continuing.");
    const generation = selectionGeneration.current;
    const submitted = actionState.submitted;
    const verifySelection = () =>
      prepareSelectedDaoAction({
        client: publicClient,
        deployment: daoExecutionDeployment(deployment),
        submitted,
        selectedProposalId: proposalId,
        account: address,
        mode,
        isCurrent: () =>
          active.current &&
          session.isCurrent(lease) &&
          generation === selectionGeneration.current,
      });
    const currentPackage = await verifySelection();
    await submitWrite(
      {
        abi: daoGovernorAbi,
        address: governor,
        functionName: mode,
        args: [
          currentPackage.targets,
          currentPackage.values,
          currentPackage.calldatas,
          currentPackage.descriptionHash,
        ],
      },
      mode === "queue"
        ? "Proposal queued in the Timelock."
        : "Timelock execution confirmed.",
      lease,
      undefined,
      verifySelection,
    );
  }

  return (
    <section
      className={`dao-console ${styles.console}`}
      aria-label="DAO ownership verification and governance"
    >
      {!configured ? (
        <div className="dao-alert dao-alert--blocked">
          <strong>DAO deployment not configured</strong>
          <p>
            Governor, Vault, voting token and action-registry addresses are all
            required. Writes fail closed.
          </p>
        </div>
      ) : null}

      <div className="dao-console__grid">
        <article className="dao-panel">
          <p className="approved-eyebrow">1 · Verify rights</p>
          <h2>Token-gated membership</h2>
          <dl className="dao-metrics">
            <div>
              <dt>RWA custody</dt>
              <dd>{rwaEligible ? "Verified" : "Blocked"}</dd>
            </div>
            <div>
              <dt>Wallet control</dt>
              <dd>{verified ? "Verified" : "Not verified"}</dd>
            </div>
            <DaoAccountMetrics
              authenticated={authenticated}
              balance={balance}
              votes={votes}
              totalSupply={totalSupply}
              balanceKnown={balanceKnown}
              votesKnown={votesKnown}
              supplyKnown={supplyKnown}
            />
            <div>
              <dt>Proposal threshold</dt>
              <dd>{shortUnits(proposalThreshold)} · 10%</dd>
            </div>
          </dl>
          {!authenticated && (
            <p>
              Sign in with the connected holder wallet to view account data or
              request a DAO action.
            </p>
          )}
          {!isConnected ? (
            <p>Connect the corresponding holder wallet to continue.</p>
          ) : null}
          {isConnected && !correctChain ? (
            <p className="dao-error">Switch the wallet to Hoodi.</p>
          ) : null}
          <div className="dao-actions-row">
            <button
              disabled={
                !authenticated ||
                !configured ||
                !isConnected ||
                !correctChain ||
                signaturePending ||
                transactionPending
              }
              onClick={() => void runAction(verifyOwnership)}
              type="button"
            >
              {signaturePending ? "Verifying…" : "Verify wallet control"}
            </button>
            <button
              disabled={
                !member ||
                !correctChain ||
                balance === 0n ||
                votes > 0n ||
                transactionPending
              }
              onClick={() => void runAction(delegateToSelf)}
              type="button"
            >
              Activate voting power
            </button>
          </div>
          <p className="dao-note">
            Membership is derived from the corresponding RWA token. A signature
            proves address control but is not stored and grants no asset
            transfer.
          </p>
        </article>

        <article className="dao-panel">
          <p className="approved-eyebrow">2 · Inspect and vote</p>
          <h2>Snapshot proposal</h2>
          <label>
            Proposal ID
            <input
              inputMode="numeric"
              onChange={(event) => {
                selectionGeneration.current++;
                setProposalInput(event.target.value);
              }}
              value={selectedProposalInput}
            />
          </label>
          {proposalEnabled ? (
            <dl className="dao-metrics">
              <DaoSnapshotWeight
                snapshot={proposalSnapshot}
                snapshotKnown={snapshotKnown}
                weight={snapshotVotes}
                weightKnown={snapshotVotesKnown}
                authenticated={authenticated}
              />
              <div>
                <dt>Class</dt>
                <dd>{proposalKinds[Number(proposalKind ?? 0)] ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {proposalState === undefined
                    ? "Unavailable"
                    : (proposalStates[Number(proposalState)] ?? "Unknown")}
                </dd>
              </div>
              <div>
                <dt>For</dt>
                <dd>{shortUnits(proposalVotes?.[1] ?? 0n)}</dd>
              </div>
              <div>
                <dt>Required, strictly over</dt>
                <dd>{shortUnits(requiredForVotes ?? 0n)}</dd>
              </div>
            </dl>
          ) : null}
          <div className="dao-actions-row">
            <button
              disabled={
                !canVote ||
                !correctChain ||
                proposalId === null ||
                transactionPending
              }
              onClick={() => void runAction((lease) => castVote(1, lease))}
              type="button"
            >
              Vote for
            </button>
            <button
              disabled={
                !canVote ||
                !correctChain ||
                proposalId === null ||
                transactionPending
              }
              onClick={() => void runAction((lease) => castVote(0, lease))}
              type="button"
            >
              Vote against
            </button>
            <button
              disabled={
                !canVote ||
                !correctChain ||
                proposalId === null ||
                transactionPending
              }
              onClick={() => void runAction((lease) => castVote(2, lease))}
              type="button"
            >
              Abstain
            </button>
          </div>
          <p className="dao-note">
            To continue a proposal created by another member or browser,{" "}
            <a href="/dao/proposals/execute">
              load its published execution terms
            </a>
            .
          </p>
          <p className="dao-note">
            Voting weight comes from the proposal snapshot, preventing transfers
            or temporary borrowing from being counted twice. A later transfer
            does not remove voting power already recorded at that snapshot.
          </p>
        </article>
      </div>

      <DaoProposalDraftWorkspace
        expected={{
          chainId: String(supportedChain.id),
          governor: deployment.governorAddress ?? "",
          token: deployment.tokenAddress ?? "",
          vault: deployment.vaultAddress ?? "",
          actionRegistry: deployment.actionRegistryAddress ?? "",
        }}
        currentForm={{
          actionType,
          description,
          marketName,
          evidenceHash,
          evidenceURI,
          amountWei,
          t0,
          observationStart,
          tradeCount,
          dueDate,
        }}
        disabled={transactionPending || signaturePending}
        onApply={(form) => {
          setActionType(form.actionType);
          setDescription(form.description);
          setMarketName(form.marketName);
          setEvidenceHash(form.evidenceHash);
          setEvidenceURI(form.evidenceURI);
          setAmountWei(form.amountWei);
          setT0(form.t0);
          setObservationStart(form.observationStart);
          setTradeCount(form.tradeCount);
          setDueDate(form.dueDate);
        }}
      />

      <form className="dao-panel dao-composer" onSubmit={createProposal}>
        <div>
          <p className="approved-eyebrow">3 · Propose</p>
          <h2>Evidence-bound RWA action</h2>
        </div>
        <label>
          Action class
          <select
            onChange={(event) =>
              setActionType(event.target.value as ActionType)
            }
            value={actionType}
          >
            <option value="market">
              Change approved trading market · &gt;50%
            </option>
            <option value="warehouse">
              Move physical warehouse · &gt;66.6667%
            </option>
            <option value="auction">
              Request physical auction · &gt;66.6667%
            </option>
            <option value="sale">Request physical sale · &gt;66.6667%</option>
            <option value="custodian">
              Change physical custodian · &gt;66.6667%
            </option>
            <option value="failure">
              Record shared failure cost · &gt;66.6667%
            </option>
            <option value="buyout30">
              Forced buyout · 30-day VWAP · &gt;80%
            </option>
            <option value="buyout10">
              Forced buyout · last 10 actual trades · &gt;80%
            </option>
          </select>
        </label>
        <label>
          Description
          <textarea
            maxLength={1000}
            minLength={12}
            onChange={(event) => setDescription(event.target.value)}
            required
            value={description}
          />
        </label>
        {actionType === "market" ? (
          <label>
            Destination approved market
            <input
              onChange={(event) => setMarketName(event.target.value)}
              required
              value={marketName}
            />
          </label>
        ) : null}
        <label>
          Evidence hash (bytes32)
          <input
            onChange={(event) => setEvidenceHash(event.target.value)}
            pattern="^0x[0-9a-fA-F]{64}$"
            required
            value={evidenceHash}
          />
        </label>
        <label>
          Evidence URI
          <input
            onChange={(event) => setEvidenceURI(event.target.value)}
            placeholder="https://… or ipfs://…"
            required
            value={evidenceURI}
          />
        </label>
        {actionType === "failure" || actionType.startsWith("buyout") ? (
          <label>
            {actionType === "failure"
              ? "Total failure cost (wei)"
              : "Forced buyout unit price (wei)"}
            <input
              inputMode="numeric"
              onChange={(event) => setAmountWei(event.target.value)}
              required
              value={amountWei}
            />
          </label>
        ) : null}
        {actionType === "failure" ? (
          <label>
            Payment due date (Unix seconds)
            <input
              inputMode="numeric"
              onChange={(event) => setDueDate(event.target.value)}
              required
              value={dueDate}
            />
          </label>
        ) : null}
        {actionType.startsWith("buyout") ? (
          <>
            <label>
              T0 initiation time (Unix seconds)
              <input
                inputMode="numeric"
                onChange={(event) => setT0(event.target.value)}
                required
                value={t0}
              />
            </label>
            <label>
              Observation start (
              {actionType === "buyout10" ? "must be 0" : "T0 minus 30 days"})
              <input
                inputMode="numeric"
                onChange={(event) => setObservationStart(event.target.value)}
                required
                value={observationStart}
              />
            </label>
            <label>
              Actual trade count (
              {actionType === "buyout10" ? "must be 10" : "must be positive"})
              <input
                inputMode="numeric"
                onChange={(event) => setTradeCount(event.target.value)}
                required
                value={tradeCount}
              />
            </label>
          </>
        ) : null}
        <button
          disabled={!canPropose || !correctChain || transactionPending}
          type="submit"
        >
          {transactionPending ? "Transaction in progress…" : "Create proposal"}
        </button>
        {!canPropose ? (
          <p className="dao-note">
            Creating a proposal requires verified membership and at least 10%
            delegated snapshot voting power.
          </p>
        ) : null}
      </form>

      {authenticated && proposalPackage ? (
        <section className="dao-panel">
          <p className="approved-eyebrow">4 · Timelock</p>
          <h2>Queue and execute the selected proposal package</h2>
          <p data-no-translate>
            Proposal {proposalPackage.proposalId.toString()}
          </p>
          <p>{proposalPackage.description}</p>
          {!selectedPackage && (
            <p role="status">
              This saved package does not match the selected Proposal ID. Select
              it before continuing.
            </p>
          )}
          <p className="dao-note">
            Before requesting a transaction, the original creation receipt, DAO
            binding, current membership, proposal state and timelock are checked
            again.
          </p>
          <div className="dao-actions-row">
            {!selectedPackage && (
              <button
                type="button"
                disabled={transactionPending}
                onClick={() => {
                  selectionGeneration.current++;
                  setProposalInput(proposalPackage.proposalId.toString());
                }}
              >
                Select saved proposal
              </button>
            )}
            <button
              disabled={
                !member ||
                !correctChain ||
                !selectedPackage ||
                transactionPending ||
                proposalState !== 4
              }
              onClick={() =>
                void runAction((lease) => queueOrExecute("queue", lease))
              }
              type="button"
            >
              Queue succeeded proposal
            </button>
            <button
              disabled={
                !member ||
                !correctChain ||
                !selectedPackage ||
                transactionPending ||
                proposalState !== 5
              }
              onClick={() =>
                void runAction((lease) => queueOrExecute("execute", lease))
              }
              type="button"
            >
              Execute after timelock
            </button>
          </div>
        </section>
      ) : null}

      <div className="dao-alert dao-alert--warning">
        <strong>Physical-action and closeout warning</strong>
        <p>
          Failed off-chain actions, including auctions, may create costs shared
          by holders. This release records assessments and deadlines but cannot
          debit or forcibly close a position. Any closeout mechanism remains
          disabled until detailed rules, BC securities-law review, notice and
          dispute procedures, independent audit and a separate approval are
          complete.
        </p>
      </div>

      {authenticated && notice ? <p className="dao-status">{notice}</p> : null}
      {authenticated && transaction?.phase === "confirmed" ? (
        <p className="dao-status">{transaction.success}</p>
      ) : null}
      {authenticated && actionError ? (
        <p className="dao-error">{actionError}</p>
      ) : null}
      {authenticated && recoveryNotice ? (
        <p className="dao-status">{recoveryNotice}</p>
      ) : null}
      {authenticated && transaction ? (
        <>
          <p className="dao-status" data-no-translate>
            Transaction: {transaction.hash} ·{" "}
            {transaction.phase === "unknown"
              ? "confirmation unavailable"
              : transaction.phase}
          </p>
          {transaction.error ? (
            <p className="dao-error">{transaction.error}</p>
          ) : null}
          {transaction.phase === "unknown" ? (
            <button
              type="button"
              disabled={actionBusy || !correctChain}
              onClick={() =>
                void runAction(
                  (lease) => checkReceipt(transaction, lease),
                  true,
                )
              }
            >
              Check transaction confirmation
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
