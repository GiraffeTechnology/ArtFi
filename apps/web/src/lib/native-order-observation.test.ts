import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { nativeOrderFromAuthorization } from "./native-order";
import {
  nativeOrderObservationFreshness,
  readNativeOrderObservation,
} from "./native-order-observation";

const market = "0x1000000000000000000000000000000000000001";
const seller = "0x1000000000000000000000000000000000000020";
const asset = "0x1000000000000000000000000000000000000002";
const hash = "0x" + "a".repeat(64);
function order(kind: "whole" | "fraction" = "fraction", salt = "1") {
  return nativeOrderFromAuthorization(
    kind,
    JSON.stringify({
      intent: {
        seller,
        paymentToken: asset,
        buyer: "0x0000000000000000000000000000000000000000",
        salt,
        startsAt: 1000,
        endsAt: 2000,
        epoch: "0",
        ...(kind === "whole"
          ? { collection: asset, tokenId: "1", price: "2" }
          : { assetToken: asset, maxAmount: "10", unitPrice: "2" }),
      },
      signature: "0x",
    }),
    market,
  );
}
function fixture() {
  const block = { number: 50n, timestamp: 1500n, hash };
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(
    async (_query: { blockTag?: string; blockNumber?: bigint }) => ({
      ...block,
    }),
  );
  const values: Record<string, unknown> = {
    sellerEpoch: 0n,
    intentFilled: 4n,
    intentUsed: false,
  };
  const readContract = vi.fn(
    async ({
      functionName,
    }: {
      functionName: string;
      blockNumber?: bigint;
    }): Promise<unknown> => values[functionName],
  );
  const client = {
    getChainId,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  return { client, getChainId, getBlock, readContract, block };
}
describe("public native-order coherent chain observations", () => {
  it("reads one block for the entire page and rechecks that block before returning any state", async () => {
    const f = fixture(),
      orders = [order("fraction", "1"), order("fraction", "2")];
    const result = await readNativeOrderObservation(f.client, orders, {
      now: () => 10000,
    });
    expect(result).toMatchObject({
      chainId: 560048,
      blockNumber: "50",
      blockHash: hash,
      blockTimestamp: "1500",
      observedAt: 10000,
    });
    expect(Object.values(result.states)).toEqual([
      { label: "Partially filled", remaining: "6", blockNumber: "50" },
      { label: "Partially filled", remaining: "6", blockNumber: "50" },
    ]);
    expect(f.getBlock.mock.calls).toEqual([
      [{ blockTag: "latest" }],
      [{ blockNumber: 50n }],
    ]);
    for (const [args] of f.readContract.mock.calls)
      expect(args).toMatchObject({ blockNumber: 50n });
    expect(f.getChainId).toHaveBeenCalledTimes(2);
  });
  it("keeps consumed whole authority distinct from a proven sale", async () => {
    const f = fixture();
    f.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "intentUsed" ? true : 0n,
    );
    const result = await readNativeOrderObservation(f.client, [order("whole")]);
    expect(Object.values(result.states)[0]).toMatchObject({
      label: "Settled or withdrawn",
      remaining: "0",
    });
  });
  it("rejects missing or changed canonical blocks, chain switches and incomplete RPC results", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) =>
        f.getBlock.mockResolvedValueOnce({ ...f.block, hash: null } as never),
      (f: ReturnType<typeof fixture>) =>
        f.getBlock
          .mockResolvedValueOnce(f.block)
          .mockResolvedValueOnce({ ...f.block, hash: "0x" + "b".repeat(64) }),
      (f: ReturnType<typeof fixture>) =>
        f.getBlock
          .mockResolvedValueOnce(f.block)
          .mockResolvedValueOnce({ ...f.block, number: 51n }),
      (f: ReturnType<typeof fixture>) =>
        f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1),
      (f: ReturnType<typeof fixture>) =>
        f.readContract.mockRejectedValue(new Error("TEST_ONLY unavailable")),
    ]) {
      const f = fixture();
      mutate(f);
      await expect(
        readNativeOrderObservation(f.client, [order()]),
      ).rejects.toThrow();
    }
  });
  it("rejects wrong RPC result types instead of treating them as open authority", async () => {
    for (const invalid of [undefined, "0", -1n, 1n << 256n, false]) {
      const f = fixture();
      f.readContract.mockResolvedValue(invalid as never);
      await expect(
        readNativeOrderObservation(f.client, [order()]),
      ).rejects.toThrow();
    }
    const f = fixture();
    f.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "intentUsed" ? ("false" as never) : 0n,
    );
    await expect(
      readNativeOrderObservation(f.client, [order("whole")]),
    ).rejects.toThrow();
  });
  it("rejects empty, oversized, duplicate or mixed-kind pages before RPC calls", async () => {
    const f = fixture();
    for (const list of [
      [],
      [order(), order()],
      Array.from({ length: 21 }, (_, i) => order("fraction", String(i))),
      [order(), order("whole")],
    ]) {
      await expect(
        readNativeOrderObservation(f.client, list),
      ).rejects.toThrow();
    }
    expect(f.getChainId).not.toHaveBeenCalled();
  });
  it("copies signed terms before awaiting a reader", async () => {
    const f = fixture(),
      original = order();
    let resume!: (chainId: number) => void;
    f.getChainId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const pending = readNativeOrderObservation(f.client, [original]);
    await Promise.resolve();
    await Promise.resolve();
    original.intent.maxAmount = "999";
    resume(560048);
    const result = await pending;
    expect(Object.values(result.states)[0]!.remaining).toBe("6");
  });
  it("retires cancelled work and does not start more reads when an outstanding RPC eventually returns", async () => {
    const f = fixture(),
      controller = new AbortController();
    let resume!: (value: typeof f.block) => void;
    f.getBlock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const pending = readNativeOrderObservation(f.client, [order()], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(f.getBlock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    resume(f.block);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it("bounds a pending RPC and ignores its late completion", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let resume!: (value: typeof f.block) => void;
      f.getBlock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resume = resolve;
          }),
      );
      const pending = readNativeOrderObservation(f.client, [order()], {
        timeoutMs: 100,
      });
      const refused = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await refused;
      resume(f.block);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.readContract).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps snapshot freshness a display label, including clock regression", () => {
    const value = { observedAt: 10000 };
    expect(nativeOrderObservationFreshness(value, 40000)).toBe("recent");
    expect(nativeOrderObservationFreshness(value, 40001)).toBe("older");
    expect(nativeOrderObservationFreshness(value, 9999)).toBe(
      "clock-unavailable",
    );
    expect(nativeOrderObservationFreshness(value, NaN)).toBe(
      "clock-unavailable",
    );
  });
});
