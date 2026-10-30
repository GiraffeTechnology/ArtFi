import { isAddress, type Address, type PublicClient } from "viem";
import { daoGovernorAbi, daoVotingTokenAbi } from "./dao-contracts";
import {
  assertPublishedDaoAction,
  readPublishedDaoExecution,
  type DaoExecutionDeployment,
  type PublishedDaoExecution,
} from "./dao-published-execution";

type Reader = Parameters<typeof readPublishedDaoExecution>[0] &
  Pick<PublicClient, "simulateContract" | "chain">;

/** Re-read business evidence after the final asynchronous authentication. */
export async function verifyPublishedDaoActionAtWallet({
  client,
  deployment,
  reviewed,
  account,
  mode,
  assertCurrent,
}: {
  client: Reader;
  deployment: DaoExecutionDeployment;
  reviewed: PublishedDaoExecution;
  account: Address;
  mode: "queue" | "execute";
  assertCurrent: () => void;
}): Promise<PublishedDaoExecution> {
  assertCurrent();
  if (!isAddress(account) || /^0x0{40}$/i.test(account))
    throw Error("The corresponding holder account is required.");
  const current = await readPublishedDaoExecution(
    client,
    deployment,
    reviewed.transactionHash,
  );
  assertCurrent();
  if (
    current.proposal.proposalId !== reviewed.proposal.proposalId ||
    current.creationBlockHash !== reviewed.creationBlockHash
  )
    throw Error("The reviewed proposal changed.");
  assertPublishedDaoAction(current, mode);
  const balance = await client.readContract({
    address: deployment.tokenAddress,
    abi: daoVotingTokenAbi,
    functionName: "balanceOf",
    args: [account],
    blockNumber: current.blockNumber,
  });
  assertCurrent();
  if (typeof balance !== "bigint" || balance <= 0n)
    throw Error("Corresponding holder membership is required.");
  const proposal = current.proposal;
  await client.simulateContract({
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
    chain: client.chain,
  });
  assertCurrent();
  const [chain, created, observed] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockNumber: current.creationBlock }),
    client.getBlock({ blockNumber: current.blockNumber }),
  ]);
  assertCurrent();
  if (
    chain !== 560048 ||
    created.number !== current.creationBlock ||
    created.hash !== current.creationBlockHash ||
    observed.number !== current.blockNumber ||
    observed.hash !== current.blockHash
  )
    throw Error("The proposal observation changed during simulation.");
  return current;
}
