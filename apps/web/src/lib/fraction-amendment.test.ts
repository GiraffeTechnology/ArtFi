import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  retireFractionForAmendment,
  freshFractionSalt,
  assertRetiredFractionForReplacement,
} from "./fraction-amendment";
import { anyFractionBuyer, type FractionSaleIntent } from "./fraction-intent";

const seller = "0x1000000000000000000000000000000000000001";
const market = "0x1000000000000000000000000000000000000002";
const original: FractionSaleIntent = {
  seller,
  assetToken: market,
  paymentToken: market,
  buyer: anyFractionBuyer,
  maxAmount: 10n,
  unitPrice: 2n,
  salt: 1n,
  startsAt: 1000,
  endsAt: 2000,
  epoch: 0n,
};
function fixture(filled = 4n, epoch = 0n) {
  let consumed = filled;
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string }) =>
      functionName === "sellerEpoch" ? epoch : consumed,
  );
  const client = {
    getChainId: vi.fn(async () => 560048),
    getBlock: vi.fn(async () => ({
      number: 20n,
      hash: `0x${"ab".repeat(32)}`,
      timestamp: 1500n,
    })),
    readContract,
  } as unknown as PublicClient;
  const revoke = vi.fn(async () => {
    consumed = 10n;
  });
  const assertCurrent = vi.fn();
  return {
    client,
    market,
    original: { ...original },
    seller,
    revoke,
    assertCurrent,
    setConsumed: (value: bigint) => {
      consumed = value;
    },
  } as const;
}
describe("fraction replacement authority", () => {
  it("retires the original before allowing a fresh replacement signature", async () => {
    const f = fixture();
    const observed = await retireFractionForAmendment(f);
    expect(f.revoke).toHaveBeenCalledOnce();
    expect(observed.retired).toBe(true);
    expect(f.client.readContract).toHaveBeenCalledTimes(4);
  });
  it.each([
    [10n, 0n],
    [4n, 1n],
  ])(
    "resumes after reload or epoch revocation without a second withdrawal",
    async (filled, epoch) => {
      const f = fixture(filled, epoch);
      expect((await retireFractionForAmendment(f)).retired).toBe(true);
      expect(f.revoke).not.toHaveBeenCalled();
    },
  );
  it("does not accept a successful receipt if the old chain authority is still live", async () => {
    const f = fixture();
    f.revoke.mockImplementation(async () => {});
    await expect(retireFractionForAmendment(f)).rejects.toThrow("still live");
  });
  it("stops for an unconfirmed or rejected revocation", async () => {
    const f = fixture();
    f.revoke.mockRejectedValue(new Error("receipt pending"));
    await expect(retireFractionForAmendment(f)).rejects.toThrow(
      "receipt pending",
    );
  });
  it("rejects a different seller, wrong chain or lost session before continuing", async () => {
    const f = fixture();
    await expect(
      retireFractionForAmendment({ ...f, seller: market }),
    ).rejects.toThrow("original seller");
    vi.mocked(f.client.getChainId).mockResolvedValue(1);
    await expect(retireFractionForAmendment(f)).rejects.toThrow(
      "different chain",
    );
    f.assertCurrent.mockImplementation(() => {
      throw new Error("session changed");
    });
    await expect(retireFractionForAmendment(f)).rejects.toThrow(
      "session changed",
    );
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("generates a new bounded salt even for identical terms in the same block", () => {
    const first = freshFractionSalt();
    const second = freshFractionSalt();
    expect(first).not.toBe(second);
    expect(first).toBeGreaterThanOrEqual(0n);
    expect(first).toBeLessThan(1n << 256n);
  });
});

describe("canonical amendment observations and delayed replacement signing", () => {
  const block = {
    number: 20n,
    hash: `0x${"ab".repeat(32)}` as const,
    timestamp: 1500n,
  };
  it("does not let caller mutation replace the original retirement threshold", async () => {
    const f = fixture();
    vi.mocked(f.client.getChainId).mockImplementation(async () => {
      f.original.epoch = 1n;
      f.original.maxAmount = 4n;
      return 560048;
    });
    expect((await retireFractionForAmendment(f)).retired).toBe(true);
    expect(f.revoke).toHaveBeenCalledOnce();
  });
  it("detaches the returned block from a provider object changed during contract reads", async () => {
    const f = fixture(10n);
    const observed = { ...block };
    vi.mocked(f.client.getBlock).mockImplementation(
      async (args) =>
        (args && "blockNumber" in args ? { ...block } : observed) as never,
    );
    vi.mocked(f.client.readContract).mockImplementation(async (args) => {
      Object.assign(observed, {
        number: 21n,
        hash: `0x${"cd".repeat(32)}`,
        timestamp: 1501n,
      });
      return (args.functionName === "sellerEpoch" ? 0n : 10n) as never;
    });
    const result = await retireFractionForAmendment(f);
    expect(result.block).toEqual(block);
    expect(Object.isFrozen(result.block)).toBe(true);
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it.each(["hash", "number", "timestamp"] as const)(
    "does not accept retirement from a changed canonical block %s",
    async (field) => {
      const f = fixture(10n);
      vi.mocked(f.client.getBlock)
        .mockResolvedValueOnce({ ...block } as never)
        .mockResolvedValueOnce({
          ...block,
          [field]:
            field === "hash" ? `0x${"cd".repeat(32)}` : block[field] + 1n,
        } as never);
      await expect(retireFractionForAmendment(f)).rejects.toThrow(
        "observed block changed",
      );
      expect(f.revoke).not.toHaveBeenCalled();
    },
  );
  it("rejects a chain switch before publishing the retirement observation", async () => {
    const f = fixture(10n);
    vi.mocked(f.client.getChainId)
      .mockResolvedValueOnce(560048)
      .mockResolvedValueOnce(1);
    await expect(retireFractionForAmendment(f)).rejects.toThrow(
      "chain or observed block changed",
    );
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it.each([
    ["number", null],
    ["number", undefined],
    ["number", -1n],
    ["number", 20],
    ["timestamp", undefined],
    ["timestamp", -1n],
    ["timestamp", 1n << 48n],
    ["hash", undefined],
    ["hash", "0x"],
    ["hash", `0x${"0".repeat(64)}`],
  ])(
    "does not read authorization from an unavailable block %s=%s",
    async (field, value) => {
      const f = fixture(10n);
      vi.mocked(f.client.getBlock).mockResolvedValue({
        ...block,
        [field as string]: value,
      } as never);
      await expect(retireFractionForAmendment(f)).rejects.toThrow(
        "mined block",
      );
      expect(f.client.readContract).not.toHaveBeenCalled();
      expect(f.revoke).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, -1n, 0, 1n << 256n])(
    "does not interpret malformed epoch %s as revocation",
    async (value) => {
      const f = fixture();
      vi.mocked(f.client.readContract).mockImplementation(
        async (args) =>
          (args.functionName === "sellerEpoch" ? value : 4n) as never,
      );
      await expect(retireFractionForAmendment(f)).rejects.toThrow(
        "chain state is unavailable",
      );
      expect(f.revoke).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, null, -1n, 10, 1n << 256n])(
    "does not interpret malformed consumption %s as retirement",
    async (value) => {
      const f = fixture();
      vi.mocked(f.client.readContract).mockImplementation(
        async (args) =>
          (args.functionName === "sellerEpoch" ? 0n : value) as never,
      );
      await expect(retireFractionForAmendment(f)).rejects.toThrow(
        "chain state is unavailable",
      );
      expect(f.revoke).not.toHaveBeenCalled();
    },
  );
  it("stops before starting contract reads if the session retires during chain lookup", async () => {
    const f = fixture();
    let live = true;
    vi.mocked(f.client.getChainId).mockImplementation(async () => {
      live = false;
      return 560048;
    });
    f.assertCurrent.mockImplementation(() => {
      if (!live) throw new Error("session changed");
    });
    await expect(retireFractionForAmendment(f)).rejects.toThrow(
      "session changed",
    );
    expect(f.client.getBlock).not.toHaveBeenCalled();
    expect(f.client.readContract).not.toHaveBeenCalled();
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("reads again after a wait and refuses a restored old authorization without replaying its withdrawal", async () => {
    const f = fixture(10n);
    expect((await retireFractionForAmendment(f)).retired).toBe(true);
    f.setConsumed(4n);
    const sign = vi.fn();
    await expect(
      (async () => {
        await assertRetiredFractionForReplacement({ ...f, expectedEpoch: 0n });
        sign();
      })(),
    ).rejects.toThrow("old authorization is live again");
    expect(sign).not.toHaveBeenCalled();
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("refuses stale replacement terms after the seller epoch changes during a wait", async () => {
    const f = fixture(10n);
    await retireFractionForAmendment(f);
    vi.mocked(f.client.readContract).mockImplementation(
      async (args) => (args.functionName === "sellerEpoch" ? 1n : 10n) as never,
    );
    await expect(
      assertRetiredFractionForReplacement({ ...f, expectedEpoch: 0n }),
    ).rejects.toThrow("seller epoch changed");
    expect(f.revoke).not.toHaveBeenCalled();
  });
  it("allows a fresh replacement after exact retirement and epoch revalidation", async () => {
    const f = fixture(4n, 1n);
    const result = await assertRetiredFractionForReplacement({
      ...f,
      expectedEpoch: 1n,
    });
    expect(result.retired).toBe(true);
    expect(result.epoch).toBe(1n);
    expect(f.revoke).not.toHaveBeenCalled();
  });
});
