import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  stringToHex,
  isAddress,
  isHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { daoActionsAbi, daoGovernorAbi } from "../src/lib/dao-contracts";
import { proposalPackageId } from "../src/lib/dao-action-state";
import { publishedProposalEvent } from "../src/lib/dao-published-execution";
export const address = (n: string) => ("0x" + n.repeat(40)) as Address;
export const hash = (n: string) => ("0x" + n.repeat(64)) as Hex;
export const deployment = {
  governorAddress: address("1"),
  actionRegistryAddress: address("2"),
  tokenAddress: address("3"),
  vaultAddress: address("4"),
};
/** Synthetic chain adapter only; never a signer, provider or acceptance record. */
export function createDaoSelectedFixture() {
  const description = "TEST_ONLY selected DAO market migration";
  const base = {
    description,
    descriptionHash: keccak256(stringToHex(description)),
    targets: [deployment.actionRegistryAddress] as const,
    values: [0n] as const,
    calldatas: [
      encodeFunctionData({
        abi: daoActionsAbi,
        functionName: "recordMarketMigration",
        args: [hash("a"), hash("b"), "https://example.invalid/TEST_ONLY"],
      }),
    ] as const,
  };
  const proposal = { ...base, proposalId: proposalPackageId(base) };
  const submitted = { proposal, transactionHash: hash("d") };
  const log = {
    address: deployment.governorAddress,
    topics: encodeEventTopics({
      abi: [publishedProposalEvent],
      eventName: "ProposalCreated",
    }),
    data: encodeAbiParameters(publishedProposalEvent.inputs, [
      proposal.proposalId,
      address("5"),
      proposal.targets,
      proposal.values,
      [""],
      proposal.calldatas,
      10n,
      20n,
      description,
    ]),
    removed: false,
    blockNumber: 50n,
    blockHash: hash("c"),
    transactionHash: hash("d"),
    transactionIndex: 0,
    logIndex: 0,
  };
  const controls = {
    chainId: 560048,
    state: 4,
    eta: 0n,
    balance: 10n,
    eligible: true,
    receiptStatus: "success",
    removed: false,
    finalChainId: 560048,
    finalCreationHash: hash("c"),
    finalObservationHash: hash("e"),
    finalCreationNumber: 50n,
    finalObservationNumber: 100n,
    failSimulation: false,
    unknownWrite: false,
    onBalance: undefined as undefined | (() => void | Promise<void>),
    onSimulation: undefined as undefined | (() => void | Promise<void>),
    onReceipt: undefined as undefined | (() => void | Promise<void>),
  };
  const calls: { method: string; input?: unknown }[] = [];
  let simulated = false;
  // Immutable synthetic transaction records model the same request that the mock wallet accepted.
  const transactions = new Map<
    Hex,
    {
      hash: Hex;
      chainId: number;
      from: Address;
      to: Address;
      nonce: number;
      value: bigint;
      input: Hex;
    }
  >([
    [
      hash("d"),
      {
        hash: hash("d"),
        chainId: 560048,
        from: address("6"),
        to: deployment.governorAddress,
        nonce: 1,
        value: 0n,
        input: encodeFunctionData({
          abi: daoGovernorAbi,
          functionName: "proposeWithKind",
          args: [
            proposal.targets,
            proposal.values,
            proposal.calldatas,
            proposal.description,
            1,
          ],
        }),
      },
    ],
  ]);
  function recordSubmittedTransaction(request: Record<string, unknown>) {
    if (
      !isAddress(String(request.account)) ||
      !isAddress(String(request.address)) ||
      request.chainId !== 560048 ||
      !Array.isArray(request.abi) ||
      typeof request.functionName !== "string" ||
      !Array.isArray(request.args) ||
      (request.value !== undefined && request.value !== 0n)
    )
      throw Error("TEST_ONLY invalid submitted transaction metadata");
    const input = encodeFunctionData({
      abi: request.abi as Abi,
      functionName: request.functionName,
      args: request.args,
    });
    if (!isHex(input)) throw Error("TEST_ONLY invalid submitted calldata");
    transactions.set(
      hash("f"),
      Object.freeze({
        hash: hash("f"),
        chainId: 560048,
        from: request.account as Address,
        to: request.address as Address,
        nonce: 2,
        value: 0n,
        input,
      }),
    );
  }
  const reader = {
    getTransaction: async (input: { hash: Hex }) => {
      calls.push({ method: "getTransaction", input });
      const transaction = transactions.get(input.hash);
      if (!transaction) throw Error("TEST_ONLY unknown transaction hash");
      return { ...transaction };
    },
    getChainId: async () => {
      calls.push({ method: "getChainId" });
      return simulated ? controls.finalChainId : controls.chainId;
    },
    getTransactionReceipt: async () => {
      calls.push({ method: "getTransactionReceipt" });
      await controls.onReceipt?.();
      return {
        status: controls.receiptStatus,
        transactionHash: hash("d"),
        blockNumber: 50n,
        blockHash: hash("c"),
        logs: [{ ...log, removed: controls.removed }],
      };
    },
    getBlock: async (input: { blockNumber?: bigint }) => {
      calls.push({ method: "getBlock", input });
      return input.blockNumber === 50n
        ? {
            number: simulated ? controls.finalCreationNumber : 50n,
            hash: simulated ? controls.finalCreationHash : hash("c"),
            timestamp: 900n,
          }
        : {
            number: simulated ? controls.finalObservationNumber : 100n,
            hash: simulated ? controls.finalObservationHash : hash("e"),
            timestamp: 1000n,
          };
    },
    getCode: async () => "0x6000",
    readContract: async (input: {
      functionName: string;
      blockNumber?: bigint;
      args?: unknown;
    }) => {
      calls.push({ method: input.functionName, input });
      switch (input.functionName) {
        case "rwaVault":
          return deployment.vaultAddress;
        case "actionRegistry":
          return deployment.actionRegistryAddress;
        case "token":
          return deployment.tokenAddress;
        case "rwaEligible":
          return controls.eligible;
        case "state":
          return controls.state;
        case "proposalKind":
          return 1;
        case "proposalEta":
          return controls.eta;
        case "hashProposal":
          return proposal.proposalId;
        case "balanceOf":
          await controls.onBalance?.();
          return controls.balance;
        default:
          throw Error("Unexpected synthetic read: " + input.functionName);
      }
    },
    simulateContract: async (input: unknown) => {
      calls.push({ method: "simulateContract", input });
      await controls.onSimulation?.();
      if (controls.failSimulation)
        throw Error("TEST_ONLY contract simulation reverted");
      simulated = true;
      return { request: input, result: proposal.proposalId };
    },
    verifyMessage: async () => true,
    waitForTransactionReceipt: async (input: { hash: Hex }) => {
      calls.push({ method: "waitForTransactionReceipt", input });
      if (controls.unknownWrite && input.hash === hash("f"))
        throw Error("TEST_ONLY unavailable receipt");
      if (!transactions.has(input.hash))
        throw Error("TEST_ONLY unknown transaction hash");
      return {
        status: "success",
        transactionHash: input.hash,
        blockNumber: 50n,
        blockHash: hash("c"),
        logs:
          input.hash === hash("d")
            ? [{ ...log, removed: controls.removed }]
            : [],
      };
    },
  };
  return {
    controls,
    recordSubmittedTransaction,
    proposal,
    submitted,
    log,
    calls,
    client: reader as unknown as PublicClient,
  };
}
