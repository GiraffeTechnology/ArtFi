import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { daoActionsAbi } from "./dao-contracts";
import { proposalPackageId } from "./dao-action-state";
import {
  assertPublishedDaoAction,
  daoExecutionDeployment,
  decodePublishedProposal,
  publishedActionKind,
  publishedDaoReadDeadline,
  publishedProposalEvent,
  readPublishedDaoExecution,
} from "./dao-published-execution";

const address = (n: string) => ("0x" + n.repeat(40)) as Address;
const hash = (n: string) => ("0x" + n.repeat(64)) as Hex;
const deployment = {
  governorAddress: address("1"),
  actionRegistryAddress: address("2"),
  tokenAddress: address("3"),
  vaultAddress: address("4"),
};
function fixture() {
  const calldata = encodeFunctionData({
    abi: daoActionsAbi,
    functionName: "recordMarketMigration",
    args: [hash("a"), hash("b"), "https://example.invalid/TEST_ONLY"],
  });
  const description = "TEST_ONLY published market migration";
  const proposal = {
    targets: [deployment.actionRegistryAddress] as const,
    values: [0n] as const,
    calldatas: [calldata] as const,
    description,
    descriptionHash: keccak256(stringToHex(description)),
  };
  const proposalId = proposalPackageId(proposal);
  const encodedTopics = encodeEventTopics({
    abi: [publishedProposalEvent],
    eventName: "ProposalCreated",
  });
  const topics: Hex[] = encodedTopics.map((topic) => {
    if (typeof topic !== "string")
      throw new Error("The fixture requires complete event topics.");
    return topic;
  });
  const data = encodeAbiParameters(publishedProposalEvent.inputs, [
    proposalId,
    address("5"),
    proposal.targets,
    proposal.values,
    [""],
    proposal.calldatas,
    10n,
    20n,
    description,
  ]);
  const log = {
    address: deployment.governorAddress,
    topics,
    data,
    removed: false,
    blockNumber: 50n,
    blockHash: hash("c"),
    transactionHash: hash("d"),
    transactionIndex: 0,
    logIndex: 0,
  };
  let chainId = 560048;
  let state = 4;
  let kind = 1;
  let eligible: unknown = true;
  let vault: Address = deployment.vaultAddress;
  let code: Hex = "0x6000";
  let creationHash = hash("c");
  let observationHash = hash("e");
  const calls: { functionName: string; blockNumber: bigint }[] = [];
  const reader = {
    getChainId: async () => chainId,
    getTransactionReceipt: async () => ({
      status: "success",
      transactionHash: hash("d"),
      blockNumber: 50n,
      blockHash: hash("c"),
      logs: [log],
    }),
    getBlock: async (input: { blockNumber?: bigint }) =>
      input.blockNumber === 50n
        ? { number: 50n, hash: creationHash, timestamp: 900n }
        : { number: 100n, hash: observationHash, timestamp: 1000n },
    getCode: async () => code,
    readContract: async (input: {
      functionName: string;
      blockNumber: bigint;
    }) => {
      calls.push(input);
      switch (input.functionName) {
        case "rwaVault":
          return vault;
        case "actionRegistry":
          return deployment.actionRegistryAddress;
        case "token":
          return deployment.tokenAddress;
        case "rwaEligible":
          return eligible;
        case "state":
          return state;
        case "proposalKind":
          return kind;
        case "proposalEta":
          return state === 5 ? 990n : 0n;
        case "hashProposal":
          return proposalId;
        default:
          throw Error("unexpected read");
      }
    },
  };
  return {
    proposalId,
    proposal,
    log,
    reader,
    calls,
    setChain: (value: number) => {
      chainId = value;
    },
    setState: (value: number) => {
      state = value;
    },
    setKind: (value: number) => {
      kind = value;
    },
    setEligible: (value: unknown) => {
      eligible = value;
    },
    setVault: (value: Address) => {
      vault = value;
    },
    setCode: (value: Hex) => {
      code = value;
    },
    setCreationHash: (value: Hex) => {
      creationHash = value;
    },
    setObservationHash: (value: Hex) => {
      observationHash = value;
    },
  };
}
type Reader = Parameters<typeof readPublishedDaoExecution>[0];
describe("original on-chain DAO execution terms", () => {
  it("restores the exact package without this browser's saved submission", () => {
    const f = fixture();
    const result = decodePublishedProposal([f.log], deployment);
    expect(result).toEqual({ ...f.proposal, proposalId: f.proposalId });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.calldatas)).toBe(true);
    expect(publishedActionKind(result)).toBe(1);
  });
  it("requires four nonzero existing deployment bindings", () => {
    expect(daoExecutionDeployment(deployment)).toEqual(deployment);
    expect(() =>
      daoExecutionDeployment({ ...deployment, tokenAddress: address("0") }),
    ).toThrow();
    expect(() =>
      daoExecutionDeployment({ governorAddress: deployment.governorAddress }),
    ).toThrow();
  });
  it("rejects other governors, duplicate creation events and removed records", () => {
    const f = fixture();
    for (const logs of [
      [],
      [{ ...f.log, address: address("9") }],
      [f.log, f.log],
      [{ ...f.log, removed: true }],
    ]) {
      expect(() => decodePublishedProposal(logs, deployment)).toThrow();
    }
  });
  it("refuses mutated terms even when their event data decodes", () => {
    const f = fixture();
    const changed = {
      ...f.log,
      data: encodeAbiParameters(publishedProposalEvent.inputs, [
        f.proposalId,
        address("5"),
        f.proposal.targets,
        f.proposal.values,
        [""],
        f.proposal.calldatas,
        10n,
        20n,
        "Different description",
      ]),
    };
    expect(() => decodePublishedProposal([changed], deployment)).toThrow(
      /identity/,
    );
  });
  it("rejects a nonzero value or a target outside this DAO action registry", () => {
    const f = fixture();
    for (const [targets, values] of [
      [[address("9")], [0n]],
      [f.proposal.targets, [1n]],
    ] as const) {
      const data = encodeAbiParameters(publishedProposalEvent.inputs, [
        f.proposalId,
        address("5"),
        targets,
        values,
        [""],
        f.proposal.calldatas,
        10n,
        20n,
        f.proposal.description,
      ]);
      expect(() =>
        decodePublishedProposal([{ ...f.log, data }], deployment),
      ).toThrow(/scope/);
    }
  });
  it("pins all current contract reads to one mined block and checks both canonical blocks", async () => {
    const f = fixture();
    const result = await readPublishedDaoExecution(
      f.reader as unknown as Reader,
      deployment,
      hash("d"),
    );
    expect(result.proposal.proposalId).toBe(f.proposalId);
    expect(result.creationBlock).toBe(50n);
    expect(result.blockNumber).toBe(100n);
    expect(result.state).toBe(4);
    expect(f.calls.length).toBe(8);
    expect(f.calls.every((call) => call.blockNumber === 100n)).toBe(true);
    expect(() => assertPublishedDaoAction(result, "queue")).not.toThrow();
    expect(() => assertPublishedDaoAction(result, "execute")).toThrow();
  });
  it("rejects wrong chain, binding, kind, RWA eligibility and absent code", async () => {
    const mutations = [
      (f: ReturnType<typeof fixture>) => f.setChain(1),
      (f: ReturnType<typeof fixture>) => f.setVault(address("9")),
      (f: ReturnType<typeof fixture>) => f.setKind(2),
      (f: ReturnType<typeof fixture>) => f.setEligible(false),
      (f: ReturnType<typeof fixture>) => f.setEligible("true"),
      (f: ReturnType<typeof fixture>) => f.setCode("0x"),
      (f: ReturnType<typeof fixture>) => f.setState(8),
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await expect(
        readPublishedDaoExecution(
          f.reader as unknown as Reader,
          deployment,
          hash("d"),
        ),
      ).rejects.toThrow();
    }
  });
  it("refuses a reorg of the original receipt block", async () => {
    const f = fixture();
    f.setCreationHash(hash("f"));
    await expect(
      readPublishedDaoExecution(
        f.reader as unknown as Reader,
        deployment,
        hash("d"),
      ),
    ).rejects.toThrow(/block changed/);
  });
  it("refuses an observation block that changes during verification", async () => {
    const f = fixture();
    let observed = 0;
    const reader = {
      ...f.reader,
      getBlock: async (input: { blockNumber?: bigint }) => {
        const value = await f.reader.getBlock(input);
        if (input.blockNumber !== 50n && ++observed > 1)
          return { ...value, hash: hash("f") };
        return value;
      },
    };
    await expect(
      readPublishedDaoExecution(
        reader as unknown as Reader,
        deployment,
        hash("d"),
      ),
    ).rejects.toThrow(/block changed/);
  });
  it("only permits queued execution after the chain timelock ETA", async () => {
    const f = fixture();
    f.setState(5);
    const result = await readPublishedDaoExecution(
      f.reader as unknown as Reader,
      deployment,
      hash("d"),
    );
    expect(() => assertPublishedDaoAction(result, "execute")).not.toThrow();
    expect(() =>
      assertPublishedDaoAction({ ...result, eta: 1001n }, "execute"),
    ).toThrow();
    expect(() =>
      assertPublishedDaoAction({ ...result, eta: 0n }, "execute"),
    ).toThrow();
    for (const state of [0, 1, 2, 3, 4, 6, 7])
      expect(() =>
        assertPublishedDaoAction({ ...result, state }, "execute"),
      ).toThrow();
  });
  it("bounded read timeout retires a hanging RPC without pretending to cancel it", async () => {
    await expect(
      publishedDaoReadDeadline(new Promise<never>(() => {}), 5),
    ).rejects.toThrow(/timed out/);
  });
});
