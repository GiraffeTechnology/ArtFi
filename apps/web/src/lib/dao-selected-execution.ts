import { type Address, type PublicClient } from "viem";
import {
  type SubmittedDaoProposal,
  type ProposalPackage,
} from "./dao-action-state";
import { daoGovernorAbi, daoVotingTokenAbi } from "./dao-contracts";
import {
  assertPublishedDaoAction,
  publishedDaoReadDeadline,
  readPublishedDaoExecution,
  type DaoExecutionDeployment,
} from "./dao-published-execution";

export function selectedDaoPackage(
  submitted: SubmittedDaoProposal | undefined,
  selectedProposalId: bigint | null,
): ProposalPackage | undefined {
  return selectedProposalId !== null &&
    submitted?.proposal.proposalId === selectedProposalId
    ? submitted.proposal
    : undefined;
}

type Reader = Parameters<typeof readPublishedDaoExecution>[0] &
  Pick<PublicClient, "simulateContract">;

/** Prepare only the selected, receipt-backed package. This never opens or clears a wallet request. */
export async function prepareSelectedDaoAction({
  client,
  deployment,
  submitted,
  selectedProposalId,
  account,
  mode,
  isCurrent,
}: {
  client: Reader;
  deployment: DaoExecutionDeployment;
  submitted: SubmittedDaoProposal;
  selectedProposalId: bigint | null;
  account: Address;
  mode: "queue" | "execute";
  isCurrent: () => boolean;
}): Promise<ProposalPackage> {
  const check = () => {
    if (!isCurrent())
      throw Error(
        "The selected proposal or wallet context changed. Review it again.",
      );
  };
  check();
  const saved = selectedDaoPackage(submitted, selectedProposalId);
  if (!saved)
    throw Error(
      "Select this package's proposal ID before queueing or execution.",
    );
  const current = await publishedDaoReadDeadline(
    readPublishedDaoExecution(client, deployment, submitted.transactionHash),
  );
  check();
  const proposal = current.proposal;
  if (
    proposal.proposalId !== selectedProposalId ||
    proposal.description !== saved.description ||
    proposal.descriptionHash !== saved.descriptionHash ||
    proposal.targets[0].toLowerCase() !== saved.targets[0].toLowerCase() ||
    proposal.values[0] !== saved.values[0] ||
    proposal.calldatas[0] !== saved.calldatas[0]
  )
    throw Error(
      "The saved execution package differs from its creation receipt.",
    );
  assertPublishedDaoAction(current, mode);
  const balance = await publishedDaoReadDeadline(
    client.readContract({
      address: deployment.tokenAddress,
      abi: daoVotingTokenAbi,
      functionName: "balanceOf",
      args: [account],
      blockNumber: current.blockNumber,
    }),
  );
  check();
  if (typeof balance !== "bigint" || balance <= 0n)
    throw Error("Current corresponding holder membership is required.");
  await publishedDaoReadDeadline(
    client.simulateContract({
      address: deployment.governorAddress,
      abi: daoGovernorAbi,
      functionName: mode,
      args: [
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        proposal.descriptionHash,
      ],
      account,
    }),
  );
  check();
  const [chainId, creation, observation] = await publishedDaoReadDeadline(
    Promise.all([
      client.getChainId(),
      client.getBlock({ blockNumber: current.creationBlock }),
      client.getBlock({ blockNumber: current.blockNumber }),
    ]),
  );
  check();
  if (
    chainId !== 560048 ||
    creation.number !== current.creationBlock ||
    creation.hash !== current.creationBlockHash ||
    observation.number !== current.blockNumber ||
    observation.hash !== current.blockHash
  )
    throw Error(
      "The chain or canonical proposal blocks changed. Reload before continuing.",
    );
  return proposal;
}
