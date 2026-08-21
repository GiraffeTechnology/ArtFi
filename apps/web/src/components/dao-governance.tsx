"use client";

import { FormEvent, useMemo, useState } from "react";
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
  if (!/^(0|[1-9][0-9]*)$/.test(value.trim())) return null;
  try {
    return BigInt(value.trim());
  } catch {
    return null;
  }
}

export function DaoGovernance({ deployment }: { deployment: DaoDeployment }) {
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

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const [verificationNonce, setVerificationNonce] = useState(() =>
    crypto.randomUUID(),
  );
  const [verifiedAddress, setVerifiedAddress] = useState<Address>();
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [proposalInput, setProposalInput] = useState("");
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

  const enabled = configured && Boolean(address);
  const { data: balance = 0n, refetch: refetchBalance } = useReadContract({
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const { data: votes = 0n, refetch: refetchVotes } = useReadContract({
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "getVotes",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled },
  });
  const { data: totalSupply = 0n } = useReadContract({
    abi: daoVotingTokenAbi,
    address: token,
    functionName: "totalSupply",
    query: { enabled: configured },
  });
  const { data: proposalThreshold = 0n } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalThreshold",
    query: { enabled: configured },
  });
  const { data: rwaEligible = false } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "rwaEligible",
    query: { enabled: configured },
  });

  const proposalId = useMemo(() => safeBigInt(proposalInput), [proposalInput]);
  const proposalEnabled = configured && proposalId !== null;
  const { data: proposalState } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "state",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const { data: proposalKind } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalKind",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const { data: proposalVotes } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "proposalVotes",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });
  const { data: requiredForVotes } = useReadContract({
    abi: daoGovernorAbi,
    address: governor,
    functionName: "requiredForVotes",
    args: [proposalId ?? 0n],
    query: { enabled: proposalEnabled },
  });

  const { signMessageAsync, isPending: signaturePending } = useSignMessage();
  const {
    data: transactionHash,
    error: transactionError,
    isPending: transactionPending,
    writeContractAsync,
  } = useWriteContract();
  const transactionReceipt = useWaitForTransactionReceipt({
    hash: transactionHash,
  });

  const ownershipMessage = useMemo(
    () =>
      `ArtFi DAO ownership verification\nChain: Sepolia (${supportedChain.id})\nGovernor: ${governor ?? "not-configured"}\nAccount: ${address ?? "not-connected"}\nNonce: ${verificationNonce}\nNo transaction or asset transfer is authorized.`,
    [address, governor, verificationNonce],
  );

  const verified = Boolean(
    address && verifiedAddress?.toLowerCase() === address.toLowerCase(),
  );
  const member = verified && balance > 0n && rwaEligible;
  const canPropose =
    member && votes >= proposalThreshold && proposalThreshold > 0n;
  const correctChain = chainId === supportedChain.id;

  async function runAction(action: () => Promise<void>) {
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The wallet action failed.",
      );
    }
  }

  async function verifyOwnership() {
    if (!address || !configured || !correctChain || !publicClient) return;
    const signature = await signMessageAsync({ message: ownershipMessage });
    const valid = await publicClient.verifyMessage({
      address,
      message: ownershipMessage,
      signature,
    });
    if (!valid) throw new Error("Wallet signature did not verify.");
    setVerifiedAddress(address);
    setVerificationNonce(crypto.randomUUID());
    setNotice(
      "Address control verified for this browser session. The signature was not stored.",
    );
  }

  async function submitWrite(
    request: Parameters<typeof writeContractAsync>[0],
    success: string,
  ) {
    if (!member || !correctChain)
      throw new Error("DAO ownership verification is required.");
    await writeContractAsync(request);
    setNotice(success);
  }

  async function delegateToSelf() {
    if (!token || !address) return;
    await submitWrite(
      {
        abi: daoVotingTokenAbi,
        address: token,
        functionName: "delegate",
        args: [address],
      },
      "Delegation submitted. Voting power updates after confirmation.",
    );
    await Promise.all([refetchBalance(), refetchVotes()]);
  }

  async function castVote(support: 0 | 1 | 2) {
    if (!governor || proposalId === null) return;
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
      setProposalPackage({
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

  async function queueOrExecute(mode: "queue" | "execute") {
    if (!governor || !proposalPackage) return;
    await submitWrite(
      {
        abi: daoGovernorAbi,
        address: governor,
        functionName: mode,
        args: [
          proposalPackage.targets,
          proposalPackage.values,
          proposalPackage.calldatas,
          proposalPackage.descriptionHash,
        ],
      },
      mode === "queue"
        ? "Proposal queued in the Timelock."
        : "Timelock execution submitted.",
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
            <div>
              <dt>Token balance</dt>
              <dd>{shortUnits(balance)}</dd>
            </div>
            <div>
              <dt>Voting power</dt>
              <dd>{shortUnits(votes)}</dd>
            </div>
            <div>
              <dt>Ownership</dt>
              <dd>{percent(balance, totalSupply)}</dd>
            </div>
            <div>
              <dt>Proposal threshold</dt>
              <dd>{shortUnits(proposalThreshold)} · 10%</dd>
            </div>
          </dl>
          {!isConnected ? (
            <p>Connect the corresponding holder wallet to continue.</p>
          ) : null}
          {isConnected && !correctChain ? (
            <p className="dao-error">Switch the wallet to Sepolia.</p>
          ) : null}
          <div className="dao-actions-row">
            <button
              disabled={
                !configured || !isConnected || !correctChain || signaturePending
              }
              onClick={() => void runAction(verifyOwnership)}
              type="button"
            >
              {signaturePending ? "Verifying…" : "Verify wallet control"}
            </button>
            <button
              disabled={
                !member || balance === 0n || votes > 0n || transactionPending
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
              onChange={(event) => setProposalInput(event.target.value)}
              value={proposalInput}
            />
          </label>
          {proposalEnabled ? (
            <dl className="dao-metrics">
              <div>
                <dt>Class</dt>
                <dd>{proposalKinds[Number(proposalKind ?? 0)] ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {proposalStates[Number(proposalState ?? 0)] ?? "Unknown"}
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
              disabled={!member || proposalId === null || transactionPending}
              onClick={() => void runAction(() => castVote(1))}
              type="button"
            >
              Vote for
            </button>
            <button
              disabled={!member || proposalId === null || transactionPending}
              onClick={() => void runAction(() => castVote(0))}
              type="button"
            >
              Vote against
            </button>
            <button
              disabled={!member || proposalId === null || transactionPending}
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
        <button disabled={!canPropose || transactionPending} type="submit">
          {transactionPending ? "Wallet confirmation…" : "Create proposal"}
        </button>
        {!canPropose ? (
          <p className="dao-note">
            Creating a proposal requires verified membership and at least 10%
            delegated snapshot voting power.
          </p>
        ) : null}
      </form>

      {proposalPackage ? (
        <section className="dao-panel">
          <p className="approved-eyebrow">4 · Timelock</p>
          <h2>Queue and execute current proposal package</h2>
          <p data-no-translate>
            Proposal {proposalPackage.proposalId.toString()}
          </p>
          <div className="dao-actions-row">
            <button
              disabled={!member || transactionPending}
              onClick={() => void runAction(() => queueOrExecute("queue"))}
              type="button"
            >
              Queue succeeded proposal
            </button>
            <button
              disabled={!member || transactionPending}
              onClick={() => void runAction(() => queueOrExecute("execute"))}
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

      {notice ? <p className="dao-status">{notice}</p> : null}
      {actionError ? <p className="dao-error">{actionError}</p> : null}
      {transactionHash ? (
        <p className="dao-status" data-no-translate>
          Transaction: {transactionHash} ·{" "}
          {transactionReceipt.isSuccess ? "confirmed" : "pending"}
        </p>
      ) : null}
      {transactionError ? (
        <p className="dao-error">{transactionError.message}</p>
      ) : null}
    </section>
  );
}
