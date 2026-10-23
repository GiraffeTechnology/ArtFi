"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import {
  type Address,
  type Hex,
  decodeEventLog,
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
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  daoActionsAbi,
  daoGovernorAbi,
  daoVotingTokenAbi,
} from "@/lib/dao-contracts";
import { supportedChain } from "@/lib/wagmi";

export type DaoDeployment = {
  actionRegistryAddress?: string;
  governorAddress?: string;
  tokenAddress?: string;
  vaultAddress?: string;
};

type ActionType =
  | "market"
  | "warehouse"
  | "auction"
  | "sale"
  | "custodian"
  | "failure"
  | "buyout30"
  | "buyout10";

type ProposalPackage = {
  deploymentScope: string;
  calldatas: readonly [Hex];
  description: string;
  descriptionHash: Hex;
  proposalId: bigint;
  targets: readonly [Address];
  values: readonly [bigint];
};

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

function percent(value: bigint, total: bigint): string {
  if (total === 0n) return "0.00%";
  return `${Number((value * 10_000n) / total) / 100}%`;
}

function shortUnits(value: bigint): string {
  const rendered = formatUnits(value, 18);
  const [whole, fraction = ""] = rendered.split(".");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole;
}

function safeBigInt(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value.trim())) return null;
  try {
    const parsed = BigInt(value.trim());
    return parsed < 2n ** 256n ? parsed : null;
  } catch {
    return null;
  }
}

export function DaoGovernance({ deployment }: { deployment: DaoDeployment }) {
  const configured = [
    deployment.governorAddress,
    deployment.tokenAddress,
    deployment.actionRegistryAddress,
    deployment.vaultAddress,
  ].every(
    (value) =>
      isAddress(value ?? "") &&
      value?.toLowerCase() !== "0x0000000000000000000000000000000000000000",
  );
  const deploymentScope = configured
    ? [
        supportedChain.id,
        deployment.governorAddress,
        deployment.tokenAddress,
        deployment.actionRegistryAddress,
        deployment.vaultAddress,
      ]
        .join(":")
        .toLowerCase()
    : "";
  const governor = (configured ? deployment.governorAddress : undefined) as
    Address | undefined;
  const token = (configured ? deployment.tokenAddress : undefined) as
    Address | undefined;
  const actionRegistry = (
    configured ? deployment.actionRegistryAddress : undefined
  ) as Address | undefined;

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const correctChain = chainId === supportedChain.id;
  const publicClient = usePublicClient({ chainId: supportedChain.id });
  const [verificationNonce, setVerificationNonce] = useState(() =>
    crypto.randomUUID(),
  );
  const [verifiedScope, setVerifiedScope] = useState<string>();
  const walletScope =
    address && deploymentScope
      ? `${deploymentScope}:${address.toLowerCase()}`
      : "";
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [proposalInput, setProposalInput] = useState("");
  const [creationTransaction, setCreationTransaction] = useState("");
  const [restoringPackage, setRestoringPackage] = useState(false);
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
  const [proposalPackage, setProposalPackage] = useState<ProposalPackage>();
  const actionInFlight = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const submittedTransaction = useRef<Hex | undefined>(undefined);
  const [transactionHash, setTransactionHash] = useState<Hex>();

  const enabled = configured && isConnected && correctChain && Boolean(address);
  const balanceRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const votesRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "getVotes",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const supplyRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "totalSupply",
    query: { enabled: configured },
  });
  const thresholdRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalThreshold",
    query: { enabled: configured },
  });
  const eligibilityRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "rwaEligible",
    query: { enabled: configured },
  });

  const proposalId = useMemo(() => safeBigInt(proposalInput), [proposalInput]);
  const proposalEnabled = configured && proposalId !== null;
  const stateRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "state",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const kindRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalKind",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const proposalVotesRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalVotes",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const requiredVotesRead = useReadContract({
    chainId: supportedChain.id,
    abi: daoGovernorAbi,
    address: governor,
    functionName: "requiredForVotes",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });

  const { signMessageAsync, isPending: signaturePending } = useSignMessage();
  const {
    error: transactionError,
    isPending: transactionPending,
    writeContractAsync,
  } = useWriteContract();
  const transactionReceipt = useWaitForTransactionReceipt({
    chainId: supportedChain.id,
    hash: transactionHash,
  });
  const transactionUnresolved = Boolean(
    transactionHash &&
    (!transactionReceipt.isSuccess ||
      transactionReceipt.data.transactionHash.toLowerCase() !==
        transactionHash.toLowerCase()),
  );
  const writeBusy = actionBusy || transactionPending || transactionUnresolved;

  const ownershipMessage = useMemo(
    () =>
      `ArtFi DAO wallet control verification\nChain: Hoodi (${supportedChain.id})\nDeployment: ${deploymentScope || "not-configured"}\nAccount: ${address ?? "not-connected"}\nNonce: ${verificationNonce}\nNo transaction, judicial right or asset transfer is authorized.`,
    [address, deploymentScope, verificationNonce],
  );

  const verified = Boolean(
    enabled && walletScope && verifiedScope === walletScope,
  );
  const balanceKnown =
    enabled && balanceRead.isSuccess && balanceRead.data !== undefined;
  const votesKnown =
    enabled && votesRead.isSuccess && votesRead.data !== undefined;
  const supplyKnown =
    configured && supplyRead.isSuccess && supplyRead.data !== undefined;
  const thresholdKnown =
    configured && thresholdRead.isSuccess && thresholdRead.data !== undefined;
  const eligibilityKnown =
    configured &&
    eligibilityRead.isSuccess &&
    eligibilityRead.data !== undefined;
  const member =
    verified &&
    balanceKnown &&
    balanceRead.data! > 0n &&
    eligibilityKnown &&
    eligibilityRead.data === true;
  const canPropose =
    member &&
    votesKnown &&
    thresholdKnown &&
    votesRead.data! >= thresholdRead.data! &&
    thresholdRead.data! > 0n;
  const proposalKnown =
    proposalEnabled &&
    stateRead.isSuccess &&
    kindRead.isSuccess &&
    proposalVotesRead.isSuccess &&
    requiredVotesRead.isSuccess &&
    stateRead.data !== undefined &&
    proposalStates[stateRead.data] !== undefined &&
    kindRead.data !== undefined &&
    proposalKinds[kindRead.data] !== undefined &&
    proposalVotesRead.data !== undefined &&
    requiredVotesRead.data !== undefined;
  const canVote = member && proposalKnown && stateRead.data === 1;
  const currentPackage =
    proposalPackage?.deploymentScope === deploymentScope &&
    proposalPackage.proposalId === proposalId
      ? proposalPackage
      : undefined;
  const readsFailed = [
    balanceRead,
    votesRead,
    supplyRead,
    thresholdRead,
    eligibilityRead,
    stateRead,
    kindRead,
    proposalVotesRead,
    requiredVotesRead,
  ].some((read) => read.isError);

  async function refreshReadings() {
    if (!configured) return;
    await Promise.all([
      supplyRead.refetch(),
      thresholdRead.refetch(),
      eligibilityRead.refetch(),
      ...(enabled ? [balanceRead.refetch(), votesRead.refetch()] : []),
      ...(proposalEnabled
        ? [
            stateRead.refetch(),
            kindRead.refetch(),
            proposalVotesRead.refetch(),
            requiredVotesRead.refetch(),
          ]
        : []),
    ]);
  }

  async function runAction(action: () => Promise<void>) {
    // React state alone cannot prevent two clicks before the next render.
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The wallet action failed.",
      );
    } finally {
      actionInFlight.current = false;
      setActionBusy(false);
    }
  }

  async function verifyOwnership() {
    if (!address || !configured || !correctChain || !publicClient) return;
    const signature = await signMessageAsync({
      account: address,
      message: ownershipMessage,
    });
    const valid = await publicClient.verifyMessage({
      address,
      message: ownershipMessage,
      signature,
    });
    if (!valid) throw new Error("Wallet signature did not verify.");
    setVerifiedScope(walletScope);
    setVerificationNonce(crypto.randomUUID());
    setNotice(
      "Address control verified for this browser session. The signature was not stored.",
    );
  }

  async function submitWrite(
    request: Parameters<typeof writeContractAsync>[0],
    success: string,
  ) {
    if (!member || !correctChain || !address)
      throw new Error("DAO ownership verification is required.");
    const previous = submittedTransaction.current;
    if (
      previous &&
      (!transactionReceipt.isSuccess ||
        transactionReceipt.data.transactionHash.toLowerCase() !==
          previous.toLowerCase())
    ) {
      throw new Error(
        "The previous transaction outcome is unresolved. Refresh its receipt instead of submitting another action.",
      );
    }
    const hash = await writeContractAsync({
      ...request,
      chainId: supportedChain.id,
      account: address,
    });
    submittedTransaction.current = hash;
    setTransactionHash(hash);
    setNotice(success);
  }

  async function delegateToSelf() {
    if (!token || !address || !votesKnown) return;
    await submitWrite(
      {
        abi: daoVotingTokenAbi,
        address: token,
        functionName: "delegate",
        args: [address],
      },
      "Delegation submitted. Voting power updates after confirmation.",
    );
    await Promise.all([balanceRead.refetch(), votesRead.refetch()]);
  }

  async function castVote(support: 0 | 1 | 2) {
    if (!governor || proposalId === null || !canVote) return;
    await submitWrite(
      {
        abi: daoGovernorAbi,
        address: governor,
        functionName: "castVote",
        args: [proposalId, support],
      },
      "Vote submitted. The proposal snapshot determines final voting weight.",
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
    void runAction(async () => {
      if (
        !governor ||
        !actionRegistry ||
        !publicClient ||
        !canPropose ||
        restoringPackage ||
        transactionUnresolved
      )
        return;
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
      setProposalPackage({
        deploymentScope,
        calldatas,
        description: description.trim(),
        descriptionHash,
        proposalId: nextProposalId,
        targets,
        values,
      });
      setProposalInput(nextProposalId.toString());
      await submitWrite(
        {
          abi: daoGovernorAbi,
          address: governor,
          functionName: "proposeWithKind",
          args: [targets, values, calldatas, description.trim(), kind],
        },
        "Proposal submitted. Its ID and execution package are retained for this browser session.",
      );
    });
  }

  async function restoreProposalPackage() {
    if (!governor || !actionRegistry || !publicClient || restoringPackage)
      return;
    const hash = creationTransaction.trim();
    if (!bytes32Pattern.test(hash)) {
      throw new Error("Enter the proposal creation transaction hash.");
    }
    setRestoringPackage(true);
    setProposalPackage(undefined);
    setNotice("");
    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: hash as Hex,
      });
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      const canonical = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      if (
        receipt.status !== "success" ||
        receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        finalized.number < receipt.blockNumber ||
        canonical.hash !== receipt.blockHash
      )
        throw new Error("Unconfirmed receipt");
      const events = receipt.logs
        .filter((log) => log.address.toLowerCase() === governor.toLowerCase())
        .flatMap((log) => {
          try {
            const event = decodeEventLog({
              abi: daoGovernorAbi,
              eventName: "ProposalCreated",
              data: log.data,
              topics: log.topics,
              strict: true,
            });
            if (
              log.removed ||
              log.transactionHash !== receipt.transactionHash ||
              log.blockHash !== receipt.blockHash ||
              log.blockNumber !== receipt.blockNumber
            ) {
              return [];
            }
            return [event.args];
          } catch {
            return [];
          }
        });
      if (events.length !== 1) throw new Error("Ambiguous proposal receipt");
      const event = events[0];
      if (
        event.targets.length !== 1 ||
        event.values.length !== 1 ||
        event.calldatas.length !== 1 ||
        event.signatures.length !== 1 ||
        event.signatures[0] !== "" ||
        event.values[0] !== 0n ||
        event.targets[0].toLowerCase() !== actionRegistry.toLowerCase() ||
        !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(event.calldatas[0])
      )
        throw new Error("Unexpected proposal action");
      const descriptionHash = keccak256(stringToHex(event.description));
      const id = await publicClient.readContract({
        abi: daoGovernorAbi,
        address: governor,
        functionName: "hashProposal",
        args: [event.targets, event.values, event.calldatas, descriptionHash],
        blockNumber: receipt.blockNumber,
      });
      const rechecked = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      if (id !== event.proposalId || rechecked.hash !== receipt.blockHash) {
        throw new Error("Proposal evidence changed");
      }
      setProposalPackage({
        deploymentScope,
        targets: [event.targets[0]],
        values: [0n],
        calldatas: [event.calldatas[0]],
        description: event.description,
        descriptionHash,
        proposalId: id,
      });
      setProposalInput(id.toString());
      setNotice(
        "Execution package restored from a finalized proposal receipt. This does not grant voting or execution authority; contract rules still apply.",
      );
    } catch {
      throw new Error(
        "Could not restore this configured fund's proposal. Check the creation hash and wait for finality, or retry when the chain reader is available.",
      );
    } finally {
      setRestoringPackage(false);
    }
  }

  async function queueOrExecute(mode: "queue" | "execute") {
    if (
      !governor ||
      !currentPackage ||
      !publicClient ||
      !address ||
      !member ||
      !correctChain ||
      restoringPackage ||
      transactionUnresolved
    )
      return;
    // Bind the action to the selected proposal, not a previously restored one.
    // Refresh chain state at one block; simulation also enforces the timelock.
    const blockNumber = await publicClient.getBlockNumber();
    const [computedId, state] = await Promise.all([
      publicClient.readContract({
        abi: daoGovernorAbi,
        address: governor,
        functionName: "hashProposal",
        args: [
          currentPackage.targets,
          currentPackage.values,
          currentPackage.calldatas,
          currentPackage.descriptionHash,
        ],
        blockNumber,
      }),
      publicClient.readContract({
        abi: daoGovernorAbi,
        address: governor,
        functionName: "state",
        args: [currentPackage.proposalId],
        blockNumber,
      }),
    ]);
    if (computedId !== proposalId || computedId !== currentPackage.proposalId) {
      throw new Error(
        "The execution package does not match the selected proposal.",
      );
    }
    if (state !== (mode === "queue" ? 4 : 5)) {
      throw new Error(
        mode === "queue"
          ? "Only a succeeded proposal can be queued. Refresh its readings."
          : "Only a queued proposal can be executed. Refresh its readings.",
      );
    }
    try {
      await publicClient.simulateContract({
        abi: daoGovernorAbi,
        address: governor,
        account: address,
        functionName: mode,
        args: [
          currentPackage.targets,
          currentPackage.values,
          currentPackage.calldatas,
          currentPackage.descriptionHash,
        ],
      });
    } catch {
      throw new Error(
        "The action is not currently executable, or its chain simulation is unavailable. Check the timelock and refresh; no wallet transaction was requested.",
      );
    }
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
        ? "Queue transaction submitted. Confirmation is required before claiming the proposal is queued."
        : "Execution transaction submitted. Confirmation is required before claiming execution.",
    );
  }

  return (
    <section
      className="dao-console"
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

      {configured ? (
        <div className="dao-note">
          <p>
            Readings are from the configured Hoodi fund contracts. Missing or
            failed reads are not zero balances, a pending proposal, or verified
            judicial rights. The contracts remain the authority for each action.
          </p>
          {readsFailed ? (
            <p role="alert">
              Some contract readings are unavailable. Refresh before continuing.
            </p>
          ) : null}
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void runAction(refreshReadings)}
          >
            Refresh contract readings
          </button>
        </div>
      ) : null}

      <div className="dao-console__grid">
        <article className="dao-panel">
          <p className="approved-eyebrow">1 · Verify wallet control</p>
          <h2>Fund-token membership</h2>
          <dl className="dao-metrics">
            <div>
              <dt>Governor custody eligibility</dt>
              <dd>
                {eligibilityKnown
                  ? eligibilityRead.data
                    ? "Eligible under this governor"
                    : "Not eligible under this governor"
                  : "Unavailable / not loaded"}
              </dd>
            </div>
            <div>
              <dt>Wallet control</dt>
              <dd>{verified ? "Verified" : "Not verified"}</dd>
            </div>
            <div>
              <dt>Token balance</dt>
              <dd>
                {balanceKnown
                  ? shortUnits(balanceRead.data!)
                  : "Unavailable / not loaded"}
              </dd>
            </div>
            <div>
              <dt>Voting power</dt>
              <dd>
                {votesKnown
                  ? shortUnits(votesRead.data!)
                  : "Unavailable / not loaded"}
              </dd>
            </div>
            <div>
              <dt>Share of token supply (not judicial title)</dt>
              <dd>
                {balanceKnown && supplyKnown
                  ? percent(balanceRead.data!, supplyRead.data!)
                  : "Unavailable / not loaded"}
              </dd>
            </div>
            <div>
              <dt>Proposal threshold</dt>
              <dd>
                {thresholdKnown
                  ? shortUnits(thresholdRead.data!)
                  : "Unavailable / not loaded"}
              </dd>
            </div>
          </dl>
          {!isConnected ? (
            <p>Connect the corresponding holder wallet to continue.</p>
          ) : null}
          {isConnected && !correctChain ? (
            <p className="dao-error">Switch the wallet to Hoodi.</p>
          ) : null}
          <div className="dao-actions-row">
            <button
              disabled={
                !configured ||
                !isConnected ||
                !correctChain ||
                signaturePending ||
                actionBusy
              }
              onClick={() => void runAction(verifyOwnership)}
              type="button"
            >
              {signaturePending ? "Verifying…" : "Verify wallet control"}
            </button>
            <button
              disabled={
                !member || !votesKnown || votesRead.data! > 0n || writeBusy
              }
              onClick={() => void runAction(delegateToSelf)}
              type="button"
            >
              Activate voting power
            </button>
          </div>
          <p className="dao-note">
            Membership follows this fund's contracts and rules, not a universal
            token-ownership rule. A signature proves wallet control, is not
            stored, and establishes no judicial title or asset-transfer
            authority.
          </p>
        </article>

        <article className="dao-panel">
          <p className="approved-eyebrow">2 · Inspect and vote</p>
          <h2>Snapshot proposal</h2>
          <label>
            Proposal ID
            <input
              inputMode="numeric"
              disabled={actionBusy}
              onChange={(event) => setProposalInput(event.target.value)}
              value={proposalInput}
            />
          </label>
          {proposalEnabled && !proposalKnown ? (
            <p role="status">
              Proposal readings are unavailable or loading; no state or vote
              count is inferred.
            </p>
          ) : null}
          {proposalKnown ? (
            <dl className="dao-metrics">
              <div>
                <dt>Class</dt>
                <dd>{proposalKinds[kindRead.data!]}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{proposalStates[stateRead.data!]}</dd>
              </div>
              <div>
                <dt>For</dt>
                <dd>{shortUnits(proposalVotesRead.data![1])}</dd>
              </div>
              <div>
                <dt>Required, strictly over</dt>
                <dd>{shortUnits(requiredVotesRead.data!)}</dd>
              </div>
            </dl>
          ) : null}
          <div className="dao-actions-row">
            <button
              disabled={!canVote || writeBusy}
              onClick={() => void runAction(() => castVote(1))}
              type="button"
            >
              Vote for
            </button>
            <button
              disabled={!canVote || writeBusy}
              onClick={() => void runAction(() => castVote(0))}
              type="button"
            >
              Vote against
            </button>
            <button
              disabled={!canVote || writeBusy}
              onClick={() => void runAction(() => castVote(2))}
              type="button"
            >
              Abstain
            </button>
          </div>
          <p className="dao-note">
            Voting weight comes from the proposal snapshot, preventing transfers
            or temporary borrowing from being counted twice.
          </p>
        </article>
      </div>

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
          disabled={!canPropose || writeBusy || restoringPackage}
          type="submit"
        >
          {transactionPending ? "Wallet confirmation…" : "Create proposal"}
        </button>
        {!canPropose ? (
          <p className="dao-note">
            Creating a proposal requires verified membership and at least 10%
            delegated snapshot voting power.
          </p>
        ) : null}
      </form>

      <section
        className="dao-panel"
        aria-label="Restore proposal execution package"
      >
        <h2>Resume a proposal after refresh</h2>
        <p>
          Use its creation transaction on Hoodi. Restoration is read-only and
          requires a finalized receipt from this fund's Governor; it does not
          submit a new proposal.
        </p>
        <label>
          Proposal creation transaction hash
          <input
            value={creationTransaction}
            onChange={(event) => setCreationTransaction(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          disabled={
            !configured || restoringPackage || actionBusy || transactionPending
          }
          onClick={() => void runAction(restoreProposalPackage)}
        >
          {restoringPackage
            ? "Restoring proposal…"
            : "Restore execution package"}
        </button>
      </section>

      {proposalPackage?.deploymentScope === deploymentScope &&
      !currentPackage ? (
        <p className="dao-note" role="status">
          The retained execution package belongs to proposal{" "}
          {proposalPackage.proposalId.toString()}. Select that ID or restore the
          selected proposal before queueing or executing.
        </p>
      ) : null}

      {currentPackage ? (
        <section className="dao-panel">
          <p className="approved-eyebrow">4 · Timelock</p>
          <h2>Queue and execute current proposal package</h2>
          <p data-no-translate>
            Proposal {currentPackage.proposalId.toString()}
          </p>
          <div className="dao-actions-row">
            <button
              disabled={
                !member || writeBusy || !proposalKnown || stateRead.data !== 4
              }
              onClick={() => void runAction(() => queueOrExecute("queue"))}
              type="button"
            >
              Queue succeeded proposal
            </button>
            <button
              disabled={
                !member || writeBusy || !proposalKnown || stateRead.data !== 5
              }
              onClick={() => void runAction(() => queueOrExecute("execute"))}
              type="button"
            >
              Execute after timelock
            </button>
          </div>
          <p className="dao-note">
            Execution is simulated against the current chain state before a
            wallet request. A queued state alone does not prove the timelock has
            elapsed.
          </p>
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

      {notice ? <p className="dao-status">{notice}</p> : null}
      {actionError ? <p className="dao-error">{actionError}</p> : null}
      {transactionHash ? (
        <p className="dao-status" data-no-translate>
          Transaction: {transactionHash} ·{" "}
          {transactionReceipt.isSuccess && !transactionUnresolved
            ? transactionReceipt.data.status === "success"
              ? "confirmed successfully"
              : "reverted on chain"
            : transactionReceipt.isError
              ? "receipt unavailable; outcome unknown"
              : "awaiting receipt"}
        </p>
      ) : null}
      {transactionUnresolved ? (
        <div className="dao-note" role="status">
          <p>
            This transaction has no matching terminal receipt yet. Additional
            writes are blocked in this page; a reader error or replacement does
            not prove failure. Refreshing the receipt never submits a
            transaction.
          </p>
          <button
            type="button"
            disabled={actionBusy || transactionReceipt.isFetching}
            onClick={() =>
              void runAction(async () => {
                await transactionReceipt.refetch();
              })
            }
          >
            Refresh submitted transaction receipt
          </button>
        </div>
      ) : null}
      {transactionError ? (
        <p className="dao-error">{transactionError.message}</p>
      ) : null}
    </section>
  );
}
