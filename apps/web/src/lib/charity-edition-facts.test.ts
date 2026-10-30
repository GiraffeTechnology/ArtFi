import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  readCharityEditionFacts,
  charityEditionReadTimeoutMs,
} from "./charity-edition-facts";

const address = "0x1000000000000000000000000000000000000001";
const holder = "0x2000000000000000000000000000000000000002";
const hash = `0x${"ab".repeat(32)}` as const;
const otherHash = `0x${"cd".repeat(32)}` as const;
const block = { number: 100n, hash, timestamp: 2000n };
function setup() {
  const series = {
    artworkId: hash,
    metadataHash: otherHash,
    distributionWallet: holder,
    createdAt: 1000n,
    soldOutAt: 1500n,
    physicalDonationRecordedAt: 1800n,
  };
  const facts: Record<string, unknown> = {
    totalSupply: 100n,
    balanceOf: 30n,
    PRIMARY_PRICE_WEI: 10n ** 16n,
  };
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(async () => ({ ...block }));
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string; blockNumber?: bigint }) =>
      functionName === "series" ? series : facts[functionName],
  );
  const controller = new AbortController();
  let current = true;
  const client = {
    getChainId,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  const run = (tokenId = "7") =>
    readCharityEditionFacts({
      client,
      contractAddress: address,
      expectedChainId: 560048,
      tokenId,
      signal: controller.signal,
      isCurrent: () => current,
    });
  return {
    series,
    facts,
    client,
    getChainId,
    getBlock,
    readContract,
    controller,
    run,
    retire: () => {
      current = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("current charity edition facts", () => {
  it("reads all facts at one mined block and returns only the validated edition projection", async () => {
    const f = setup();
    expect(await f.run("0007")).toEqual({
      ...f.series,
      tokenId: "7",
      createdAt: 1000,
      soldOutAt: 1500,
      physicalDonationRecordedAt: 1800,
      mintedUnits: 100n,
      distributorUnits: 30n,
      unitPriceWei: 10n ** 16n,
    });
    expect(f.readContract).toHaveBeenCalledTimes(4);
    for (const [request] of f.readContract.mock.calls)
      expect(request.blockNumber).toBe(100n);
    expect(f.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n });
    expect(f.getChainId).toHaveBeenCalledTimes(2);
  });
  it("accepts an unsold series without inventing donation or holder evidence", async () => {
    const f = setup();
    f.series.soldOutAt = 0n;
    f.series.physicalDonationRecordedAt = 0n;
    expect(await f.run()).toMatchObject({
      soldOutAt: 0,
      physicalDonationRecordedAt: 0,
    });
  });
  it.each(["0", "-1", "7x", "", (1n << 256n).toString()])(
    "rejects invalid edition %s before RPC",
    async (id) => {
      const f = setup();
      await expect(f.run(id)).rejects.toThrow();
      expect(f.getChainId).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, 100, -1n, 101n, 1n << 256n])(
    "rejects malformed or non-contract supply %s",
    async (value) => {
      const f = setup();
      f.facts.totalSupply = value;
      await expect(f.run()).rejects.toThrow();
    },
  );
  it.each([-1n, 101n, 30, 1n << 256n])(
    "rejects malformed distributor balance %s",
    async (value) => {
      const f = setup();
      f.facts.balanceOf = value;
      await expect(f.run()).rejects.toThrow();
    },
  );
  it("rejects a changed recorded primary price", async () => {
    const f = setup();
    f.facts.PRIMARY_PRICE_WEI = 1n;
    await expect(f.run()).rejects.toThrow();
  });
  it.each([0n, -1n, 2001n, 8640000000001n, 1n << 64n])(
    "rejects invalid creation timestamp %s before dependent reads",
    async (value) => {
      const f = setup();
      f.series.createdAt = value;
      await expect(f.run()).rejects.toThrow();
      expect(f.readContract).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses donation without sellout rather than displaying plausible facts", async () => {
    const f = setup();
    f.series.soldOutAt = 0n;
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects missing artwork identity", async () => {
    const f = setup();
    f.series.artworkId = `0x${"00".repeat(32)}`;
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects a replaced block after all facts return", async () => {
    const f = setup();
    f.getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValueOnce({ ...block, hash: otherHash });
    await expect(f.run()).rejects.toThrow();
  });
  it("rejects provider chain drift before publishing", async () => {
    const f = setup();
    f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
    await expect(f.run()).rejects.toThrow();
  });
  it("captures original series primitives before waiting for the parallel facts", async () => {
    const f = setup();
    const normal = f.readContract.getMockImplementation()!;
    f.readContract.mockImplementation(async (request) => {
      if (request.functionName === "totalSupply") {
        f.series.metadataHash = hash;
        f.series.distributionWallet = address;
      }
      return normal(request);
    });
    expect(await f.run()).toMatchObject({
      metadataHash: otherHash,
      distributionWallet: holder,
    });
  });
  it("retiring an older read cannot publish over a newer edition", async () => {
    const f = setup();
    let release!: (value: typeof f.series) => void;
    f.readContract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = f.run();
    const failed = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(f.readContract).toHaveBeenCalledTimes(1));
    f.retire();
    release(f.series);
    await failed;
    expect(f.readContract).toHaveBeenCalledTimes(1);
    const fresh = setup();
    expect(await fresh.run("8")).toMatchObject({ tokenId: "8" });
  });
  it("aborting an in-flight refresh does not wait for or continue its provider", async () => {
    const f = setup();
    let release!: (value: number) => void;
    f.getChainId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.run();
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.getChainId).toHaveBeenCalledOnce());
    f.controller.abort();
    await failed;
    release(560048);
    await Promise.resolve();
    expect(f.getBlock).not.toHaveBeenCalled();
  });
  it("deadline retires late provider work without another RPC", async () => {
    vi.useFakeTimers();
    const f = setup();
    let release!: (value: number) => void;
    f.getChainId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.run();
    const failed = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(charityEditionReadTimeoutMs + 1);
    await failed;
    release(560048);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getBlock).not.toHaveBeenCalled();
  });
});
