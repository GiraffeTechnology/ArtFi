import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  charityCatalogPageSize,
  readCharityCatalogPage,
} from "./charity-catalog-page";
import { charityEditionReadTimeoutMs } from "./charity-edition-facts";
const address = "0x1000000000000000000000000000000000000001";
const holder = "0x2000000000000000000000000000000000000002";
const hash = `0x${"ab".repeat(32)}` as const;
const other = `0x${"cd".repeat(32)}` as const;
const block = { number: 100n, hash, timestamp: 2000n };
function setup(count: unknown = 21n) {
  const values: Record<string, unknown> = {
    seriesCount: count,
    EDITIONS_PER_ARTWORK: 100n,
    PRIMARY_PRICE_WEI: 10n ** 16n,
    totalSupply: 100n,
    balanceOf: 63n,
  };
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(
    async (_request?: { blockTag?: string; blockNumber?: bigint }) => ({
      ...block,
    }),
  );
  const readContract = vi.fn(
    async (request: {
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) =>
      request.functionName === "series"
        ? {
            artworkId: hash,
            metadataHash: other,
            distributionWallet: holder,
            createdAt: 1000n,
            soldOutAt: 0n,
            physicalDonationRecordedAt: 0n,
          }
        : values[request.functionName],
  );
  const client = {
    getChainId,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  const controller = new AbortController();
  let current = true;
  const run = (start = 1n) =>
    readCharityCatalogPage({
      client,
      contractAddress: address,
      expectedChainId: 560048,
      start,
      signal: controller.signal,
      isCurrent: () => current,
    });
  return {
    values,
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
describe("bounded charity catalog pages", () => {
  it("reads one bounded page and every fact at the captured mined block", async () => {
    const f = setup();
    const page = await f.run();
    expect(page.seriesCount).toBe(21n);
    expect(page.editions).toHaveLength(Number(charityCatalogPageSize));
    expect(page.editions.map((e) => e.tokenId)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1)),
    );
    expect(Object.isFrozen(page.editions)).toBe(true);
    for (const [request] of f.readContract.mock.calls)
      expect(request.blockNumber).toBe(block.number);
    expect(
      f.getBlock.mock.calls
        .slice(1)
        .every(([request]) => request?.blockNumber === block.number),
    ).toBe(true);
  });
  it("keeps later pages reachable without converting the uint256 count to Number", async () => {
    const f = setup((1n << 256n) - 1n);
    const start = ((1n << 200n) / 20n) * 20n + 1n;
    const page = await f.run(start);
    expect(page.editions).toHaveLength(20);
    expect(page.editions[0].tokenId).toBe(start.toString());
    expect(page.editions[19].tokenId).toBe((start + 19n).toString());
    expect(
      f.readContract.mock.calls.filter(([r]) => r.functionName === "series"),
    ).toHaveLength(20);
  });
  it("reads the final partial page without duplicate or out-of-range IDs", async () => {
    const page = await setup().run(21n);
    expect(page.editions.map((e) => e.tokenId)).toEqual(["21"]);
  });
  it("accepts a genuinely empty catalog only on its first page", async () => {
    const f = setup(0n);
    expect((await f.run()).editions).toEqual([]);
    expect(f.readContract).toHaveBeenCalledTimes(3);
    await expect(f.run(21n)).rejects.toThrow();
  });
  it.each([0n, -1n, 2n, 1n << 256n])(
    "rejects invalid page start %s before RPC",
    async (start) => {
      const f = setup();
      await expect(f.run(start)).rejects.toThrow();
      expect(f.getChainId).not.toHaveBeenCalled();
    },
  );
  it.each([-1n, 1n << 256n, 21, null])(
    "rejects malformed series count %s",
    async (count) => {
      const f = setup(count);
      await expect(f.run()).rejects.toThrow();
      expect(f.readContract).toHaveBeenCalledTimes(3);
    },
  );
  it("rejects a page that disappeared on a new read instead of showing an empty success", async () => {
    await expect(setup(20n).run(21n)).rejects.toThrow();
  });
  it.each(["EDITIONS_PER_ARTWORK", "PRIMARY_PRICE_WEI"])(
    "refuses changed contract term %s before loading rows",
    async (key) => {
      const f = setup();
      f.values[key] = 1n;
      await expect(f.run()).rejects.toThrow();
      expect(f.readContract).toHaveBeenCalledTimes(3);
    },
  );
  it("runs at most four edition readers concurrently", async () => {
    const f = setup();
    const normal = f.readContract.getMockImplementation()!;
    let active = 0,
      maximum = 0;
    f.readContract.mockImplementation(async (request) => {
      if (request.functionName !== "series") return normal(request);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return normal(request);
    });
    expect((await f.run()).editions).toHaveLength(20);
    expect(maximum).toBe(4);
  });
  it("never returns a partial catalog when a row fails its existing fact validation", async () => {
    const f = setup(2n);
    const normal = f.readContract.getMockImplementation()!;
    f.readContract.mockImplementation(async (request) =>
      request.functionName === "totalSupply" && request.args?.[0] === 2n
        ? 99n
        : normal(request),
    );
    await expect(f.run()).rejects.toThrow();
  });
  it("refuses block replacement between page reads", async () => {
    const f = setup(1n);
    f.getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValue({ ...block, hash: other });
    await expect(f.run()).rejects.toThrow();
  });
  it("checks the final canonical block even when no editions exist", async () => {
    const f = setup(0n);
    f.getBlock
      .mockResolvedValueOnce(block)
      .mockResolvedValueOnce({ ...block, hash: other });
    await expect(f.run()).rejects.toThrow();
    expect(f.readContract).toHaveBeenCalledTimes(3);
  });
  it("checks an empty catalog's final block and chain too", async () => {
    const f = setup(0n);
    f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
    await expect(f.run()).rejects.toThrow();
  });
  it("retires aborted provider work before any dependent read", async () => {
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
  it("retires old page contexts before starting rows", async () => {
    const f = setup();
    const normal = f.readContract.getMockImplementation()!;
    f.readContract.mockImplementation(async (request) => {
      f.retire();
      return normal(request);
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.readContract).toHaveBeenCalledTimes(3);
  });
  it("deadline ends a hung count read without scheduling late rows", async () => {
    vi.useFakeTimers();
    const f = setup();
    let release!: (value: bigint) => void;
    f.readContract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.run();
    const failed = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(charityEditionReadTimeoutMs + 1);
    await failed;
    release(21n);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.readContract).toHaveBeenCalledTimes(3);
  });
});
