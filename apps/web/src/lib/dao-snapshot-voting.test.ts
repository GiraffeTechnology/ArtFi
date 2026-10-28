import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { daoGovernorAbi, daoVotingTokenAbi } from "./dao-contracts";
import { verifyDaoGovernanceAtWallet } from "./dao-governance-wallet-boundary";
import { runDaoSessionAction } from "./dao-session-action";
const address = (n: string) => ("0x" + n.repeat(40)) as Address;
const deployment = {
  governorAddress: address("1"),
  actionRegistryAddress: address("2"),
  tokenAddress: address("3"),
  vaultAddress: address("4"),
};
const account = address("5");
const vote = {
  target: deployment.governorAddress,
  input: encodeFunctionData({
    abi: daoGovernorAbi,
    functionName: "castVote",
    args: [11n, 1],
  }),
  value: "0" as const,
};
function fixture() {
  const values: Record<string, unknown> = {
    token: deployment.tokenAddress,
    actionRegistry: deployment.actionRegistryAddress,
    rwaVault: deployment.vaultAddress,
    rwaEligible: true,
    balanceOf: 0n,
    state: 1,
    proposalSnapshot: 90n,
    snapshotVotes: 10n,
    currentVotes: 0n,
  };
  const methods = {
    chain: undefined,
    getChainId: vi.fn(async () => 560048),
    getBlock: vi.fn(async () => ({
      number: 100n,
      hash: "0x" + "a".repeat(64),
    })),
    readContract: vi.fn(
      async (input: {
        address: Address;
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: bigint;
      }) =>
        input.functionName === "getVotes"
          ? values[
              input.address === deployment.governorAddress
                ? "snapshotVotes"
                : "currentVotes"
            ]
          : values[input.functionName],
    ),
    simulateContract: vi.fn(async () => ({ request: {} })),
  };
  const assertCurrent = vi.fn();
  const run = (call = vote) =>
    verifyDaoGovernanceAtWallet({
      client: methods as unknown as PublicClient,
      deployment,
      account,
      call,
      assertCurrent,
    });
  return { values, methods, run };
}
describe("DAO proposal snapshot voting authority", () => {
  it("preserves a historical voter's eligibility after all current tokens and votes move", async () => {
    const s = fixture();
    await s.run();
    expect(s.methods.simulateContract).toHaveBeenCalledOnce();
    expect(s.methods.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: deployment.governorAddress,
        functionName: "proposalSnapshot",
        args: [11n],
        blockNumber: 100n,
      }),
    );
    expect(s.methods.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: deployment.governorAddress,
        functionName: "getVotes",
        args: [account, 90n],
        blockNumber: 100n,
      }),
    );
    expect(
      s.methods.readContract.mock.calls.some(
        ([x]) => x.functionName === "balanceOf",
      ),
    ).toBe(false);
  });
  it("does not authorize a current holder without votes at the selected snapshot", async () => {
    const s = fixture();
    s.values.balanceOf = 100n;
    s.values.currentVotes = 100n;
    s.values.snapshotVotes = 0n;
    await expect(s.run()).rejects.toThrow(/snapshot/i);
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it.each([-1n, 100n, 1n << 256n, "90", null])(
    "refuses a malformed or unmined proposal snapshot %s",
    async (snapshot) => {
      const s = fixture();
      s.values.balanceOf = 1n;
      s.values.proposalSnapshot = snapshot;
      await expect(s.run()).rejects.toThrow(/snapshot/i);
      expect(s.methods.simulateContract).not.toHaveBeenCalled();
    },
  );
  it.each([-1n, 1n << 256n, "10", null])(
    "refuses malformed historical weight %s",
    async (weight) => {
      const s = fixture();
      s.values.balanceOf = 1n;
      s.values.snapshotVotes = weight;
      await expect(s.run()).rejects.toThrow(/snapshot/i);
      expect(s.methods.simulateContract).not.toHaveBeenCalled();
    },
  );
  it("retains current ownership for delegation rather than borrowing snapshot authority", async () => {
    const s = fixture();
    await expect(
      s.run({
        target: deployment.tokenAddress,
        input: encodeFunctionData({
          abi: daoVotingTokenAbi,
          functionName: "delegate",
          args: [account],
        }),
        value: "0",
      }),
    ).rejects.toThrow(/membership/i);
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("rechecks snapshot authority after the final asynchronous authentication wait", async () => {
    const s = fixture();
    s.values.balanceOf = 1n;
    let reads = 0;
    const wallet = vi.fn(async () => "submitted");
    await expect(
      runDaoSessionAction({
        account,
        chainId: 560048,
        assertSession: async () => {
          if (++reads === 2) s.values.snapshotVotes = 0n;
          return {
            id: "public-snapshot-session",
            address: account,
            chainId: 560048,
            expiresAt: Date.now() + 60000,
            accessExpiresAt: Date.now() + 30000,
          };
        },
        isCurrent: () => true,
        prepare: s.run,
        execute: async () => {
          await s.run();
          return wallet();
        },
      }),
    ).rejects.toThrow(/snapshot/i);
    expect(wallet).not.toHaveBeenCalled();
    expect(s.methods.simulateContract).toHaveBeenCalledOnce();
  });
});
