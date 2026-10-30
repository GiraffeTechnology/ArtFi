import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  readRevenueRound,
  assertReviewedRevenue,
  revenueAddress,
  revenueRoundId,
  revenueReadDeadline,
} from "./revenue-claims";
import { marketWriteJournal } from "./market-transaction";
const distributor = "0x1000000000000000000000000000000000000001" as const;
const fractionToken = "0x1000000000000000000000000000000000000002" as const;
const account = "0x1000000000000000000000000000000000000003" as const;
const payoutToken = "0x1000000000000000000000000000000000000004" as const;
const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
function fixture(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
  const getChainId = vi.fn(async () => 560048),
    getBlock = vi.fn(async () => ({ number: 100n, hash }));
  const readContract = vi.fn(
    async (input: { functionName: string; blockNumber: bigint }) =>
      values[input.functionName],
  );
  return {
    client: {
      getChainId,
      getBlock,
      getCode: vi.fn(async () => "0x6000"),
      readContract,
    } as unknown as PublicClient,
    getChainId,
    getBlock,
    readContract,
  };
}
describe("configured snapshot revenue claims", () => {
  it("keeps round IDs exact and refuses zero, noncanonical and overflowing IDs", () => {
    const max = ((1n << 256n) - 1n).toString();
    expect(revenueRoundId(max)).toBe(BigInt(max));
    for (const value of ["0", "01", "1e3", "-1", (1n << 256n).toString()])
      expect(() => revenueRoundId(value)).toThrow();
    expect(revenueAddress("0x" + "0".repeat(40))).toBeUndefined();
  });
  it("reads historical balances at one canonical block rather than current holdings or delegated votes", async () => {
    const f = fixture(),
      round = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    expect(round.claimable).toBe(30n);
    expect(round.snapshotBalance).toBe(3n);
    expect(
      f.readContract.mock.calls.every(([input]) => input.blockNumber === 100n),
    ).toBe(true);
    expect(
      f.readContract.mock.calls.some(([input]) =>
        ["balanceOf", "getPastVotes"].includes(input.functionName),
      ),
    ).toBe(false);
    expect(() => assertReviewedRevenue(round, round)).not.toThrow();
  });
  it.each([
    { fractionToken: account },
    { getPastTotalSupply: 11n },
    { getPastBalance: 11n },
    { claimable: 31n },
    { claimed: "false" },
    { clock: 20 },
    { totalClaimed: 102n },
    { distributions: [payoutToken, 101n, 0n, 20] },
    { distributionCount: 0n },
  ])(
    "refuses conflicting contract or historical evidence %o",
    async (changes) => {
      const f = fixture(changes);
      await expect(
        readRevenueRound(f.client, { distributor, fractionToken, account }, 1n),
      ).rejects.toThrow();
    },
  );
  it("does not offer a second claim and refuses changed reviewed terms", async () => {
    const f = fixture(),
      reviewed = await readRevenueRound(
        f.client,
        { distributor, fractionToken, account },
        1n,
      );
    const done = fixture({ claimed: true, claimable: 0n, totalClaimed: 30n });
    const fresh = await readRevenueRound(
      done.client,
      { distributor, fractionToken, account },
      1n,
    );
    expect(fresh.claimable).toBe(0n);
    for (const next of [
      fresh,
      { ...reviewed, account: fractionToken },
      { ...reviewed, revenueAmount: 102n },
      { ...reviewed, claimable: 29n },
    ])
      expect(() => assertReviewedRevenue(reviewed, next)).toThrow();
  });
  it("refuses wrong-chain and reorganized observations", async () => {
    const wrong = fixture();
    wrong.getChainId.mockResolvedValue(1);
    await expect(
      readRevenueRound(
        wrong.client,
        { distributor, fractionToken, account },
        1n,
      ),
    ).rejects.toThrow("Hoodi");
    const reorg = fixture();
    reorg.getBlock
      .mockResolvedValueOnce({ number: 100n, hash })
      .mockResolvedValueOnce({
        number: 100n,
        hash: ("0x" + "2".repeat(64)) as typeof hash,
      });
    await expect(
      readRevenueRound(
        reorg.client,
        { distributor, fractionToken, account },
        1n,
      ),
    ).rejects.toThrow("changed");
  });
  it("bounds a stalled observation without pretending to cancel its underlying RPC", async () => {
    await expect(
      revenueReadDeadline(() => new Promise<never>(() => {}), 1),
    ).rejects.toThrow("timed out");
  });
  it("retains an unresolved claim in the existing journal and compares before clearing", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const journal = marketWriteJournal(storage, "isolated-revenue");
    journal.record({ kind: "claim", hash });
    expect(journal.pending()).toEqual({ kind: "claim", hash });
    expect(() => journal.assertReady()).toThrow();
    journal.clear({
      kind: "claim",
      hash: ("0x" + "2".repeat(64)) as `0x${string}`,
    });
    expect(journal.pending()).toBeDefined();
    journal.clear({ kind: "claim", hash });
    expect(journal.pending()).toBeUndefined();
  });
});
