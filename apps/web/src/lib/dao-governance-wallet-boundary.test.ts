import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { daoGovernorAbi, daoVotingTokenAbi } from "./dao-contracts";
import { verifyDaoGovernanceAtWallet } from "./dao-governance-wallet-boundary";
import { runDaoSessionAction } from "./dao-session-action";
import type { DaoCallBinding } from "./dao-action-state";
const addr = (n: string) => ("0x" + n.repeat(40)) as Address;
const hash = (n: string) => ("0x" + n.repeat(64)) as Hex;
const deployment = {
  governorAddress: addr("1"),
  actionRegistryAddress: addr("2"),
  tokenAddress: addr("3"),
  vaultAddress: addr("4"),
};
const account = addr("5");
function binding(
  mode:
    | "delegate"
    | "castVote"
    | "proposeWithKind"
    | "queue"
    | "execute" = "delegate",
): DaoCallBinding {
  let input: Hex;
  if (mode === "delegate")
    input = encodeFunctionData({
      abi: daoVotingTokenAbi,
      functionName: mode,
      args: [account],
    });
  else if (mode === "castVote")
    input = encodeFunctionData({
      abi: daoGovernorAbi,
      functionName: mode,
      args: [11n, 1],
    });
  else if (mode === "proposeWithKind")
    input = encodeFunctionData({
      abi: daoGovernorAbi,
      functionName: mode,
      args: [
        [deployment.actionRegistryAddress],
        [0n],
        ["0xabcd"],
        "Public proposal fixture",
        0,
      ],
    });
  else
    input = encodeFunctionData({
      abi: daoGovernorAbi,
      functionName: mode,
      args: [[deployment.actionRegistryAddress], [0n], ["0xabcd"], hash("d")],
    });
  return {
    target:
      mode === "delegate"
        ? deployment.tokenAddress
        : deployment.governorAddress,
    input,
    value: "0",
  };
}
function fixture() {
  const state: Record<string, unknown> = {
    token: deployment.tokenAddress,
    actionRegistry: deployment.actionRegistryAddress,
    rwaVault: deployment.vaultAddress,
    rwaEligible: true,
    balanceOf: 1n,
    state: 1,
    getVotes: 10n,
    proposalThreshold: 10n,
  };
  const block = { number: 100n, hash: hash("a") };
  const methods = {
    chain: undefined,
    getChainId: vi.fn(async () => 560048),
    getBlock: vi.fn(async () => ({ ...block })),
    readContract: vi.fn(
      async (input: { functionName: string; blockNumber?: bigint }) =>
        state[input.functionName],
    ),
    simulateContract: vi.fn(
      async (_input: {
        address: Address;
        functionName: string;
        account: Address;
      }) => ({ request: {} }),
    ),
  };
  const client = methods as unknown as PublicClient;
  const assertCurrent = vi.fn();
  const verifySelection = vi.fn(async () => ({ verified: true }));
  return {
    state,
    block,
    methods,
    client,
    assertCurrent,
    verifySelection,
    run: (call = binding()) =>
      verifyDaoGovernanceAtWallet({
        client,
        deployment,
        account,
        call,
        assertCurrent,
        verifySelection,
      }),
  };
}
describe("current native DAO governance wallet boundary", () => {
  it.each([
    "delegate",
    "castVote",
    "proposeWithKind",
    "queue",
    "execute",
  ] as const)(
    "checks the original holder/deployment/call for %s",
    async (mode) => {
      const s = fixture();
      const call = binding(mode);
      await s.run(call);
      expect(s.methods.simulateContract).toHaveBeenCalledOnce();
      expect(s.methods.simulateContract.mock.calls[0][0]).toMatchObject({
        address: call.target,
        functionName: mode,
        account,
      });
      expect(
        s.methods.readContract.mock.calls.every(
          ([input]) => input.blockNumber === 100n,
        ),
      ).toBe(true);
      expect(s.methods.getChainId).toHaveBeenCalledTimes(2);
      expect(s.verifySelection).toHaveBeenCalledTimes(
        mode === "queue" || mode === "execute" ? 1 : 0,
      );
    },
  );
  it.each(["token", "actionRegistry", "rwaVault"])(
    "refuses a changed original %s binding",
    async (key) => {
      const s = fixture();
      s.state[key] = addr("9");
      await expect(s.run()).rejects.toThrow("original RWA binding");
      expect(s.methods.simulateContract).not.toHaveBeenCalled();
    },
  );
  it.each([0n, -1n, "1", null])(
    "refuses missing or malformed corresponding-holder balance %s",
    async (balance) => {
      const s = fixture();
      s.state.balanceOf = balance;
      await expect(s.run()).rejects.toThrow("membership");
      expect(s.methods.simulateContract).not.toHaveBeenCalled();
    },
  );
  it("refuses ineligible RWA membership without simulating", async () => {
    const s = fixture();
    s.state.rwaEligible = false;
    await expect(s.run()).rejects.toThrow("membership");
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("refuses a wrong-chain observation before reading contract state", async () => {
    const s = fixture();
    s.methods.getChainId.mockResolvedValueOnce(1);
    await expect(s.run()).rejects.toThrow("Hoodi");
    expect(s.methods.readContract).not.toHaveBeenCalled();
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("refuses changed canonical block identity after simulation", async () => {
    const s = fixture();
    s.methods.getBlock
      .mockResolvedValueOnce({ ...s.block })
      .mockResolvedValueOnce({ ...s.block, hash: hash("b") });
    await expect(s.run()).rejects.toThrow("observation changed");
    expect(s.methods.simulateContract).toHaveBeenCalledOnce();
  });
  it("refuses changed chain after simulation", async () => {
    const s = fixture();
    s.methods.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
    await expect(s.run()).rejects.toThrow("observation changed");
  });
  it("refuses a context retired by the final observation await", async () => {
    const s = fixture();
    let current = true;
    s.methods.simulateContract.mockImplementation(async () => {
      current = false;
      return { request: {} };
    });
    s.assertCurrent.mockImplementation(() => {
      if (!current) throw Error("retired");
    });
    await expect(s.run()).rejects.toThrow("Reconcile");
    expect(s.methods.getChainId).toHaveBeenCalledOnce();
  });
  it("keeps an inactive vote out of wallet simulation", async () => {
    const s = fixture();
    s.state.state = 4;
    await expect(s.run(binding("castVote"))).rejects.toThrow("active proposal");
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it.each([
    { getVotes: 9n, proposalThreshold: 10n },
    { getVotes: 10n, proposalThreshold: 0n },
    { getVotes: "10", proposalThreshold: 10n },
  ])("checks the existing contract proposal threshold %s", async (values) => {
    const s = fixture();
    Object.assign(s.state, values);
    await expect(s.run(binding("proposeWithKind"))).rejects.toThrow(
      "threshold",
    );
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("refuses delegation to another account", async () => {
    const s = fixture();
    const call = {
      ...binding(),
      input: encodeFunctionData({
        abi: daoVotingTokenAbi,
        functionName: "delegate",
        args: [addr("9")],
      }),
    };
    await expect(s.run(call)).rejects.toThrow("corresponding holder");
    expect(s.methods.getChainId).not.toHaveBeenCalled();
  });
  it("refuses a different target or unsupported public method", async () => {
    const s = fixture();
    await expect(s.run({ ...binding(), target: addr("9") })).rejects.toThrow(
      "target changed",
    );
    await expect(
      s.run({
        target: deployment.governorAddress,
        input: encodeFunctionData({
          abi: daoGovernorAbi,
          functionName: "proposalThreshold",
        }),
        value: "0",
      }),
    ).rejects.toThrow("outside this interface");
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("requires the existing saved-selection verifier for queue or execute", async () => {
    const s = fixture();
    await expect(
      verifyDaoGovernanceAtWallet({
        client: s.client,
        deployment,
        account,
        call: binding("queue"),
        assertCurrent: s.assertCurrent,
      }),
    ).rejects.toThrow("saved proposal");
    expect(s.methods.getChainId).not.toHaveBeenCalled();
  });
  it("stops after a saved-selection verifier fails", async () => {
    const s = fixture();
    s.verifySelection.mockRejectedValue(Error("private saved state"));
    await expect(s.run(binding("execute"))).rejects.toThrow("Reconcile");
    expect(s.methods.simulateContract).not.toHaveBeenCalled();
  });
  it("does not expose underlying read or simulation diagnostics", async () => {
    const s = fixture();
    s.methods.simulateContract.mockRejectedValue(
      Error("private RPC key or topology"),
    );
    try {
      await s.run();
      throw Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("could not be verified");
      expect(String(error)).not.toContain("private RPC");
    }
  });
  it("rechecks membership after the final asynchronous platform session check", async () => {
    const s = fixture();
    let count = 0;
    const wallet = vi.fn(async () => "submitted");
    const session = {
      id: "public-session",
      address: account,
      chainId: 560048,
      expiresAt: Date.now() + 60000,
      accessExpiresAt: Date.now() + 30000,
    };
    await expect(
      runDaoSessionAction({
        account,
        chainId: 560048,
        assertSession: async () => {
          if (++count === 2) s.state.balanceOf = 0n;
          return session;
        },
        isCurrent: () => true,
        prepare: () => s.run(),
        execute: async () => {
          await s.run();
          return wallet();
        },
      }),
    ).rejects.toThrow("membership");
    expect(wallet).not.toHaveBeenCalled();
    expect(s.methods.simulateContract).toHaveBeenCalledOnce();
  });
});
