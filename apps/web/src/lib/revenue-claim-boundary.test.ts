import { describe, it, expect, vi, afterEach } from "vitest";
import type { PublicClient } from "viem";
import { readRevenueRound, verifyRevenueClaimAtWallet } from "./revenue-claims";
const distributor = "0x1000000000000000000000000000000000000001" as const,
  fractionToken = "0x1000000000000000000000000000000000000002" as const,
  account = "0x1000000000000000000000000000000000000003" as const,
  payoutToken = "0x1000000000000000000000000000000000000004" as const,
  hash = ("0x" + "1".repeat(64)) as `0x${string}`;
function setup() {
  const values: Record<string, unknown> = {
    fractionToken,
    distributionCount: 3n,
    distributions: [payoutToken, 101n, 10n, 20],
    claimed: false,
    claimable: 30n,
    totalClaimed: 0n,
    clock: 21,
    getPastBalance: 3n,
    getPastTotalSupply: 10n,
  };
  const calls: string[] = [];
  const getChainId = vi.fn(async () => {
    calls.push("chain");
    return 560048;
  });
  const getBlock = vi.fn(async () => {
    calls.push("block");
    return { number: 100n, hash };
  });
  const readContract = vi.fn(
    async (i: {
      functionName: string;
      args?: unknown[];
      blockNumber: bigint;
    }) => {
      calls.push(i.functionName);
      return values[i.functionName];
    },
  );
  const simulateContract = vi.fn(async () => {
    calls.push("simulate");
    return { request: { TEST_ONLY: true } };
  });
  const current = vi.fn(() => {
    calls.push("lease");
  });
  const client = {
    getChainId,
    getBlock,
    getCode: vi.fn(async () => "0x6000"),
    readContract,
    simulateContract,
  } as unknown as PublicClient;
  return {
    client,
    values,
    calls,
    getChainId,
    getBlock,
    readContract,
    simulateContract,
    current,
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("revenue wallet callback verification", () => {
  it("rechecks exact historical entitlement then simulates and verifies its original canonical block", async () => {
    const f = setup(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    f.calls.length = 0;
    expect(
      await verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
    ).toMatchObject({ id: 1n, claimable: 30n, blockHash: hash });
    const simulation = f.calls.indexOf("simulate");
    expect(simulation).toBeGreaterThan(f.calls.indexOf("claimed"));
    expect(f.calls.lastIndexOf("block")).toBeGreaterThan(simulation);
    expect(f.calls.lastIndexOf("chain")).toBeGreaterThan(simulation);
    expect(f.simulateContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        address: distributor,
        functionName: "claim",
        args: [1n],
        account,
      }),
    );
    expect(
      f.readContract.mock.calls.every(([i]) => i.blockNumber === 100n),
    ).toBe(true);
  });
  it.each([
    { claimed: true, claimable: 0n, totalClaimed: 30n },
    { distributions: [payoutToken, 102n, 10n, 20] },
    { getPastBalance: 4n, claimable: 40n },
    { fractionToken: account },
    { claimed: "false" },
    { claimable: 29n },
  ])(
    "refuses changed or malformed evidence before simulation %#",
    async (values) => {
      const f = setup(),
        reviewed = await readRevenueRound(
          f.client,
          { distributor, fractionToken, account },
          1n,
        );
      Object.assign(f.values, values);
      await expect(
        verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
      ).rejects.toThrow();
      expect(f.simulateContract).not.toHaveBeenCalled();
    },
  );
  it("refuses a reorg after a successful simulation", async () => {
    const f = setup(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    f.simulateContract.mockImplementation(async () => {
      f.getBlock.mockResolvedValue({
        number: 100n,
        hash: ("0x" + "2".repeat(64)) as typeof hash,
      });
      return { request: { TEST_ONLY: true } };
    });
    await expect(
      verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
    ).rejects.toThrow("changed during simulation");
  });
  it("refuses a chain departure after simulation", async () => {
    const f = setup(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    f.simulateContract.mockImplementation(async () => {
      f.getChainId.mockResolvedValue(1);
      return { request: { TEST_ONLY: true } };
    });
    await expect(
      verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
    ).rejects.toThrow("changed during simulation");
  });
  it("refuses missing or mismatched final block identity", async () => {
    for (const block of [
      { number: 101n, hash },
      { number: 100n, hash: null },
    ]) {
      const f = setup(),
        reviewed = await readRevenueRound(
          f.client,
          { distributor, fractionToken, account },
          1n,
        );
      f.simulateContract.mockImplementation(async () => {
        f.getBlock.mockResolvedValue(
          block as { number: bigint; hash: typeof hash },
        );
        return { request: { TEST_ONLY: true } };
      });
      await expect(
        verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
      ).rejects.toThrow();
    }
  });
  it("checks retirement before reads and after every asynchronous boundary", async () => {
    for (const at of [1, 2, 3, 4]) {
      const f = setup(),
        reviewed = await readRevenueRound(
          f.client,
          { distributor, fractionToken, account },
          1n,
        );
      let n = 0;
      const lease = () => {
        if (++n === at) throw new Error("TEST_ONLY retired");
      };
      await expect(
        verifyRevenueClaimAtWallet(f.client, reviewed, lease),
      ).rejects.toThrow("retired");
      if (at <= 2) expect(f.simulateContract).not.toHaveBeenCalled();
    }
  });
  it("bounds stalled reads and never proceeds from a late result", async () => {
    const f = setup(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    let release: (v: unknown) => void = () => {};
    f.readContract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.useFakeTimers();
    const pending = verifyRevenueClaimAtWallet(f.client, reviewed, f.current);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12001);
    await rejected;
    release(fractionToken);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.simulateContract).not.toHaveBeenCalled();
  });
  it("bounds stalled simulation without treating it as cancellation or allowing a wallet call", async () => {
    const f = setup(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    f.simulateContract.mockImplementation(() => new Promise<never>(() => {}));
    vi.useFakeTimers();
    const rejected = expect(
      verifyRevenueClaimAtWallet(f.client, reviewed, f.current),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12001);
    await rejected;
  });
});
