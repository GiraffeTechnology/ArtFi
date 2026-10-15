import {
  decodeEventLog,
  decodeFunctionData,
  encodeEventTopics,
  isAddress,
  keccak256,
  parseAbiItem,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { daoActionsAbi, daoGovernorAbi } from "./dao-contracts";
import { proposalPackageId, type ProposalPackage } from "./dao-action-state";

export type DaoExecutionDeployment = {
  governorAddress: Address;
  actionRegistryAddress: Address;
  tokenAddress: Address;
  vaultAddress: Address;
};
const nonzero = (v: unknown): v is Address =>
  typeof v === "string" && isAddress(v) && !/^0x0{40}$/i.test(v);
const hash = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const uint256 = (v: unknown): v is bigint =>
  typeof v === "bigint" && v >= 0n && v < 1n << 256n;
export function daoExecutionDeployment(input: {
  governorAddress?: string;
  actionRegistryAddress?: string;
  tokenAddress?: string;
  vaultAddress?: string;
}): DaoExecutionDeployment {
  if (
    !Object.values(input).every(nonzero) ||
    Object.values(input).length !== 4 ||
    !nonzero(input.governorAddress) ||
    !nonzero(input.actionRegistryAddress) ||
    !nonzero(input.tokenAddress) ||
    !nonzero(input.vaultAddress)
  )
    throw Error("All four existing DAO deployment addresses are required.");
  return input as DaoExecutionDeployment;
}
export const publishedProposalEvent = parseAbiItem(
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
);
const topic = encodeEventTopics({
  abi: [publishedProposalEvent],
  eventName: "ProposalCreated",
})[0];
const bindingAbi = [
  parseAbiItem("function rwaVault() view returns (address)"),
  parseAbiItem("function actionRegistry() view returns (address)"),
  parseAbiItem("function token() view returns (address)"),
  parseAbiItem(
    "function proposalEta(uint256 proposalId) view returns (uint256)",
  ),
] as const;
export const publishedProposalStates = [
  "Pending",
  "Active",
  "Cancelled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
] as const;
type InputLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  removed?: boolean;
};
export function decodePublishedProposal(
  logs: readonly InputLog[],
  deployment: DaoExecutionDeployment,
): ProposalPackage {
  const events = logs.filter(
    (log) =>
      log.address.toLowerCase() === deployment.governorAddress.toLowerCase() &&
      log.topics[0] === topic,
  );
  if (events.length !== 1 || events[0].removed === true)
    throw Error("One canonical proposal creation event is required.");
  const args = decodeEventLog({
    abi: [publishedProposalEvent],
    data: events[0].data,
    topics: events[0].topics as [Hex, ...Hex[]],
    strict: true,
  }).args;
  if (
    !uint256(args.proposalId) ||
    args.targets.length !== 1 ||
    args.values.length !== 1 ||
    args.calldatas.length !== 1 ||
    args.signatures.length !== 1 ||
    args.signatures[0] !== "" ||
    args.targets[0].toLowerCase() !==
      deployment.actionRegistryAddress.toLowerCase() ||
    args.values[0] !== 0n ||
    !/^0x(?:[0-9a-fA-F]{2}){4,16000}$/.test(args.calldatas[0]) ||
    new TextEncoder().encode(args.description).length > 4000
  )
    throw Error(
      "The published proposal is outside the supported single-action DAO scope.",
    );
  const proposal: ProposalPackage = Object.freeze({
    proposalId: args.proposalId,
    description: args.description,
    descriptionHash: keccak256(stringToHex(args.description)),
    targets: Object.freeze([args.targets[0]]) as readonly [Address],
    values: Object.freeze([0n]) as readonly [bigint],
    calldatas: Object.freeze([args.calldatas[0]]) as readonly [Hex],
  });
  if (proposalPackageId(proposal) !== proposal.proposalId)
    throw Error(
      "Published proposal identity does not match its exact execution terms.",
    );
  return proposal;
}
export function publishedActionKind(proposal: ProposalPackage): 1 | 2 | 3 {
  const action = decodeFunctionData({
    abi: daoActionsAbi,
    data: proposal.calldatas[0],
  });
  if (action.functionName === "recordMarketMigration") return 1;
  if (
    action.functionName === "requestPhysicalAction" ||
    action.functionName === "recordSharedFailureAssessment"
  )
    return 2;
  if (action.functionName === "initiateForcedBuyout") return 3;
  throw Error("Unsupported DAO action.");
}
export function publishedActionSummary(proposal: ProposalPackage) {
  const action = decodeFunctionData({
    abi: daoActionsAbi,
    data: proposal.calldatas[0],
  });
  return {
    functionName: action.functionName,
    arguments: JSON.stringify(
      action.args,
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  };
}
export type PublishedDaoExecution = {
  proposal: ProposalPackage;
  transactionHash: Hex;
  creationBlock: bigint;
  creationBlockHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  observedAt: bigint;
  state: number;
  kind: 1 | 2 | 3;
  eta: bigint;
};
type Reader = Pick<
  PublicClient,
  | "getChainId"
  | "getTransactionReceipt"
  | "getBlock"
  | "getCode"
  | "readContract"
>;
export async function readPublishedDaoExecution(
  client: Reader,
  deployment: DaoExecutionDeployment,
  transactionHash: Hex,
): Promise<PublishedDaoExecution> {
  deployment = daoExecutionDeployment(deployment);
  if (!hash(transactionHash) || (await client.getChainId()) !== 560048)
    throw Error("Use the original proposal transaction on Hoodi.");
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  if (
    receipt.status !== "success" ||
    receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
    receipt.logs.length > 512 ||
    !hash(receipt.blockHash) ||
    receipt.blockNumber === null ||
    receipt.logs.some(
      (log) =>
        log.removed === true ||
        log.blockHash !== receipt.blockHash ||
        log.blockNumber !== receipt.blockNumber ||
        log.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
        log.data.length > 131074,
    )
  )
    throw Error(
      "The proposal transaction receipt is not a bounded canonical success.",
    );
  const proposal = decodePublishedProposal(receipt.logs, deployment);
  const block = await client.getBlock({ blockTag: "latest" });
  if (
    block.number === null ||
    !hash(block.hash) ||
    block.number < receipt.blockNumber ||
    !uint256(block.timestamp)
  )
    throw Error("A mined observation block is required.");
  const at = {
    address: deployment.governorAddress,
    blockNumber: block.number,
  } as const;
  const [code, vault, registry, token, eligible, state, kind, eta, onchainId] =
    await Promise.all([
      client.getCode(at),
      client.readContract({ ...at, abi: bindingAbi, functionName: "rwaVault" }),
      client.readContract({
        ...at,
        abi: bindingAbi,
        functionName: "actionRegistry",
      }),
      client.readContract({ ...at, abi: bindingAbi, functionName: "token" }),
      client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "rwaEligible",
      }),
      client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "state",
        args: [proposal.proposalId],
      }),
      client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "proposalKind",
        args: [proposal.proposalId],
      }),
      client.readContract({
        ...at,
        abi: bindingAbi,
        functionName: "proposalEta",
        args: [proposal.proposalId],
      }),
      client.readContract({
        ...at,
        abi: daoGovernorAbi,
        functionName: "hashProposal",
        args: [
          proposal.targets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash,
        ],
      }),
    ]);
  if (
    !code ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
    !nonzero(vault) ||
    vault.toLowerCase() !== deployment.vaultAddress.toLowerCase() ||
    !nonzero(registry) ||
    registry.toLowerCase() !== deployment.actionRegistryAddress.toLowerCase() ||
    !nonzero(token) ||
    token.toLowerCase() !== deployment.tokenAddress.toLowerCase() ||
    eligible !== true ||
    !Number.isInteger(state) ||
    state < 0 ||
    state > 7 ||
    kind !== publishedActionKind(proposal) ||
    !uint256(eta) ||
    onchainId !== proposal.proposalId
  )
    throw Error(
      "The proposal or configured DAO binding could not be verified.",
    );
  const [created, observed] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlock({ blockNumber: block.number }),
  ]);
  if (created.hash !== receipt.blockHash || observed.hash !== block.hash)
    throw Error(
      "A proposal or observation block changed. Reload before continuing.",
    );
  return Object.freeze({
    proposal,
    transactionHash,
    creationBlock: receipt.blockNumber,
    creationBlockHash: receipt.blockHash,
    blockNumber: block.number,
    blockHash: block.hash,
    observedAt: block.timestamp,
    state,
    kind: kind as 1 | 2 | 3,
    eta,
  });
}
export function assertPublishedDaoAction(
  snapshot: PublishedDaoExecution,
  mode: "queue" | "execute",
) {
  if (
    snapshot.state !== (mode === "queue" ? 4 : 5) ||
    (mode === "execute" &&
      (snapshot.eta === 0n || snapshot.eta > snapshot.observedAt))
  )
    throw Error(
      mode === "queue"
        ? "Only a succeeded proposal can be queued."
        : "The proposal must be queued and its timelock delay elapsed.",
    );
}
// The deadline retires the read result; it does not claim to cancel provider RPCs.
export async function publishedDaoReadDeadline<T>(
  work: Promise<T>,
  milliseconds = 12000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "DAO proposal reading timed out. Reload before continuing.",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
