import { describe, expect, it } from "vitest";
import {
  prepareSelectedDaoAction,
  selectedDaoPackage,
} from "./dao-selected-execution";
import {
  createDaoSelectedFixture,
  address,
  deployment,
  hash,
} from "../../test-fixtures/dao-selected";
function setup() {
  const fixture = createDaoSelectedFixture();
  let current = true;
  return {
    ...fixture,
    retire: () => {
      current = false;
    },
    run: (mode: "queue" | "execute" = "queue") =>
      prepareSelectedDaoAction({
        client: fixture.client,
        deployment,
        submitted: fixture.submitted,
        selectedProposalId: fixture.proposal.proposalId,
        account: address("6"),
        mode,
        isCurrent: () => current,
      }),
  };
}
describe("selected DAO package action boundary", () => {
  it("exposes only the exact selected saved ID, including a valid zero ID", () => {
    const f = setup();
    expect(selectedDaoPackage(f.submitted, f.proposal.proposalId)).toBe(
      f.proposal,
    );
    expect(selectedDaoPackage(f.submitted, 1n)).toBeUndefined();
    expect(selectedDaoPackage(f.submitted, null)).toBeUndefined();
    expect(
      selectedDaoPackage(undefined, f.proposal.proposalId),
    ).toBeUndefined();
    const zero = {
      ...f.submitted,
      proposal: { ...f.proposal, proposalId: 0n },
    };
    expect(selectedDaoPackage(zero, 0n)).toBe(zero.proposal);
  });
  it("refuses another inspected ID before any RPC or wallet request", async () => {
    const f = setup();
    await expect(
      prepareSelectedDaoAction({
        client: f.client,
        deployment,
        submitted: f.submitted,
        selectedProposalId: 1n,
        account: address("6"),
        mode: "queue",
        isCurrent: () => true,
      }),
    ).rejects.toThrow(/Select/);
    expect(f.calls).toEqual([]);
  });
  it("returns receipt terms after current membership and exact account/operation simulation", async () => {
    const f = setup();
    const result = await f.run();
    expect(result).toEqual(f.proposal);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.calls.find((x) => x.method === "balanceOf")?.input).toMatchObject({
      address: deployment.tokenAddress,
      blockNumber: 100n,
      args: [address("6")],
    });
    expect(
      f.calls.find((x) => x.method === "simulateContract")?.input,
    ).toMatchObject({
      address: deployment.governorAddress,
      account: address("6"),
      functionName: "queue",
      args: [
        f.proposal.targets,
        f.proposal.values,
        f.proposal.calldatas,
        f.proposal.descriptionHash,
      ],
    });
    expect(f.calls.some((x) => /write|send/i.test(x.method))).toBe(false);
  });
  it.each([
    "description",
    "descriptionHash",
    "targets",
    "values",
    "calldatas",
  ] as const)(
    "refuses a saved %s substituted after submission",
    async (field) => {
      const f = setup();
      Object.assign(f.submitted.proposal, {
        [field]: {
          description: "Changed terms",
          descriptionHash: hash("9"),
          targets: [address("9")],
          values: [1n],
          calldatas: ["0x12345678"],
        }[field],
      });
      await expect(f.run()).rejects.toThrow(/differs/);
      expect(f.calls.some((x) => x.method === "simulateContract")).toBe(false);
    },
  );
  it.each([0, 1, 2, 3, 5, 6, 7])(
    "refuses queue when current state is %i",
    async (state) => {
      const f = setup();
      f.controls.state = state;
      await expect(f.run()).rejects.toThrow(/succeeded/);
      expect(f.calls.some((x) => x.method === "simulateContract")).toBe(false);
    },
  );
  it.each([0n, 1001n])(
    "refuses execution when current ETA is %s",
    async (eta) => {
      const f = setup();
      f.controls.state = 5;
      f.controls.eta = eta;
      await expect(f.run("execute")).rejects.toThrow(/delay/);
    },
  );
  it("allows execution only after the queued proposal delay, using chain time", async () => {
    const f = setup();
    f.controls.state = 5;
    f.controls.eta = 1000n;
    await expect(f.run("execute")).resolves.toEqual(f.proposal);
    expect(
      f.calls.find((x) => x.method === "simulateContract")?.input,
    ).toMatchObject({ functionName: "execute" });
  });
  it("refuses a transferred-away membership even if the UI still showed a holding", async () => {
    const f = setup();
    f.controls.balance = 0n;
    await expect(f.run()).rejects.toThrow(/membership/);
    expect(f.calls.some((x) => x.method === "simulateContract")).toBe(false);
  });
  it("propagates a contract simulation refusal without producing wallet authorization", async () => {
    const f = setup();
    f.controls.failSimulation = true;
    await expect(f.run()).rejects.toThrow(/reverted/);
  });
  it.each(["onReceipt", "onBalance", "onSimulation"] as const)(
    "retires a context changed during %s",
    async (stage) => {
      const f = setup();
      f.controls[stage] = f.retire;
      await expect(f.run()).rejects.toThrow(/context changed/);
      if (stage !== "onSimulation")
        expect(f.calls.some((x) => x.method === "simulateContract")).toBe(
          false,
        );
    },
  );
  it("rejects an already retired context without an RPC", async () => {
    const f = setup();
    f.retire();
    await expect(f.run()).rejects.toThrow(/context changed/);
    expect(f.calls).toEqual([]);
  });
  it.each([
    ["chainId", 1],
    ["receiptStatus", "reverted"],
    ["eligible", false],
    ["removed", true],
  ] as const)(
    "retains original reader refusal for %s",
    async (field, value) => {
      const f = setup();
      Object.assign(f.controls, { [field]: value });
      await expect(f.run()).rejects.toThrow();
      expect(f.calls.some((x) => x.method === "simulateContract")).toBe(false);
    },
  );
  it.each([
    ["finalChainId", 1],
    ["finalCreationHash", hash("9")],
    ["finalObservationHash", hash("9")],
    ["finalCreationNumber", 49n],
    ["finalObservationNumber", 99n],
  ] as const)(
    "refuses post-simulation chain/canonical drift: %s",
    async (field, value) => {
      const f = setup();
      Object.assign(f.controls, { [field]: value });
      await expect(f.run()).rejects.toThrow(/canonical/);
    },
  );
});
