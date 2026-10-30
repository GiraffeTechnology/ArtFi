import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { daoGovernorAbi, daoVotingTokenAbi } from "./dao-contracts";
import { isDaoCallBinding, type DaoCallBinding } from "./dao-action-state";
import {
  daoExecutionDeployment,
  type DaoExecutionDeployment,
} from "./dao-published-execution";

const bindingsAbi = parseAbi([
  "function token() view returns (address)",
  "function actionRegistry() view returns (address)",
  "function rwaVault() view returns (address)",
]);
type Reader = Pick<
  PublicClient,
  "getChainId" | "getBlock" | "readContract" | "simulateContract" | "chain"
>;
class GovernancePreflightError extends Error {}
function stop(message: string): never {
  throw new GovernancePreflightError(message);
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint = (n: unknown): n is bigint =>
  typeof n === "bigint" && n >= 0n && n < 1n << 256n;

/** Fresh business evidence belongs after each asynchronous authentication wait. */
export async function verifyDaoGovernanceAtWallet({
  client,
  deployment,
  account,
  call,
  assertCurrent,
  verifySelection,
}: {
  client: Reader;
  deployment: DaoExecutionDeployment;
  account: Address;
  call: DaoCallBinding;
  assertCurrent: () => void;
  verifySelection?: () => Promise<unknown>;
}): Promise<void> {
  try {
    assertCurrent();
    deployment = daoExecutionDeployment(deployment);
    if (
      !isAddress(account) ||
      /^0x0{40}$/i.test(account) ||
      !isDaoCallBinding(call)
    )
      stop("The original holder and DAO call bindings are invalid.");
    const isToken = same(call.target, deployment.tokenAddress);
    if (!isToken && !same(call.target, deployment.governorAddress))
      stop("The DAO call target changed.");
    const abi = isToken ? daoVotingTokenAbi : daoGovernorAbi;
    const decoded = decodeFunctionData({ abi, data: call.input });
    if (
      !same(
        encodeFunctionData({
          abi,
          functionName: decoded.functionName,
          args: decoded.args,
        } as Parameters<typeof encodeFunctionData>[0]),
        call.input,
      )
    )
      stop("The reviewed DAO calldata changed.");
    const args = decoded.args as readonly unknown[];
    if (isToken) {
      if (
        decoded.functionName !== "delegate" ||
        typeof args[0] !== "string" ||
        !same(args[0], account)
      )
        stop("Only delegation to the corresponding holder is supported.");
    } else if (
      !["castVote", "proposeWithKind", "queue", "execute"].includes(
        decoded.functionName,
      )
    )
      stop("The DAO wallet operation is outside this interface.");
    if (
      decoded.functionName === "queue" ||
      decoded.functionName === "execute"
    ) {
      if (!verifySelection)
        stop("The saved proposal must be checked before wallet execution.");
      await verifySelection!();
      assertCurrent();
    }
    if ((await client.getChainId()) !== 560048)
      stop("The DAO reader is not on Hoodi.");
    assertCurrent();
    const block = await client.getBlock({ blockTag: "latest" });
    assertCurrent();
    if (typeof block.number !== "bigint" || block.number < 0n || !block.hash)
      stop("A mined DAO observation is required.");
    const at = {
      address: deployment.governorAddress,
      blockNumber: block.number,
    } as const;
    const [token, registry, vault, eligible] = await Promise.all([
      client.readContract({ ...at, abi: bindingsAbi, functionName: "token" }),
      client.readContract({
        ...at,
        abi: bindingsAbi,
        functionName: "actionRegistry",
      }),
      client.readContract({
        ...at,
        abi: bindingsAbi,
        functionName: "rwaVault",
      }),
      client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "rwaEligible",
      }),
    ]);
    assertCurrent();
    if (
      !same(token, deployment.tokenAddress) ||
      !same(registry, deployment.actionRegistryAddress) ||
      !same(vault, deployment.vaultAddress) ||
      eligible !== true
    )
      stop(
        "Corresponding holder membership and the original RWA binding are required.",
      );
    if (decoded.functionName !== "castVote") {
      const balance = await client.readContract({
        address: deployment.tokenAddress,
        blockNumber: block.number,
        abi: daoVotingTokenAbi,
        functionName: "balanceOf",
        args: [account],
      });
      assertCurrent();
      if (!uint(balance) || balance === 0n)
        stop("Corresponding current holder membership is required.");
    }
    if (decoded.functionName === "castVote") {
      if (!uint(args[0]) || ![0, 1, 2].includes(args[1] as number))
        stop("The vote selection is invalid.");
      const state = await client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "state",
        args: [args[0] as bigint],
      });
      assertCurrent();
      if (state !== 1)
        stop("Only the selected active proposal can receive a vote.");
      const snapshot = await client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "proposalSnapshot",
        args: [args[0] as bigint],
      });
      assertCurrent();
      if (!uint(snapshot) || snapshot >= block.number)
        stop(
          "The selected proposal snapshot must be a mined historical block.",
        );
      const weight = await client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "getVotes",
        args: [account, snapshot],
      });
      assertCurrent();
      if (!uint(weight) || weight === 0n)
        stop(
          "The corresponding account has no voting power at this proposal snapshot.",
        );
    }
    if (decoded.functionName === "proposeWithKind") {
      const [votes, threshold] = await Promise.all([
        client.readContract({
          address: deployment.tokenAddress,
          blockNumber: block.number,
          abi: daoVotingTokenAbi,
          functionName: "getVotes",
          args: [account],
        }),
        client.readContract({
          ...at,
          abi: daoGovernorAbi,
          functionName: "proposalThreshold",
        }),
      ]);
      assertCurrent();
      if (
        !uint(votes) ||
        !uint(threshold) ||
        threshold === 0n ||
        votes < threshold
      )
        stop("The current proposal voting threshold is not met.");
    }
    await client.simulateContract({
      address: call.target,
      abi,
      functionName: decoded.functionName,
      args: decoded.args,
      account,
      chain: client.chain,
    } as Parameters<PublicClient["simulateContract"]>[0]);
    assertCurrent();
    const [chain, canonical] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockNumber: block.number }),
    ]);
    assertCurrent();
    if (
      chain !== 560048 ||
      canonical.number !== block.number ||
      canonical.hash !== block.hash
    )
      stop("The DAO observation changed during simulation.");
  } catch (error) {
    if (error instanceof GovernancePreflightError) throw error;
    throw new GovernancePreflightError(
      "The DAO wallet preflight could not be verified. Reconcile saved requests before continuing.",
    );
  }
}
