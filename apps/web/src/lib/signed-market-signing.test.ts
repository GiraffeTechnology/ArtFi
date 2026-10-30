import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  verifyFractionSigningState,
  verifyWholeArtworkSigningState,
  signedMarketPreflightTimeoutMs,
} from "./signed-market-preflight";
import {
  anyBuyer,
  type SaleIntent,
  type SaleIntentDomain,
} from "./whole-artwork-intent";
import { anyFractionBuyer, type FractionSaleIntent } from "./fraction-intent";

const seller = "0x1000000000000000000000000000000000000001";
const market = "0x1000000000000000000000000000000000000002";
const asset = "0x1000000000000000000000000000000000000003";
const paymentToken = "0x1000000000000000000000000000000000000004";

function fixture(kind: "whole" | "fraction") {
  const whole: SaleIntent = {
    seller,
    collection: asset,
    tokenId: 7n,
    paymentToken,
    price: 10n,
    buyer: anyBuyer,
    salt: 1n,
    startsAt: 1000,
    endsAt: 2000,
    epoch: 0n,
  };
  const fraction: FractionSaleIntent = {
    seller,
    assetToken: asset,
    paymentToken,
    maxAmount: 10n,
    unitPrice: 2n,
    buyer: anyFractionBuyer,
    salt: 1n,
    startsAt: 1000,
    endsAt: 2000,
    epoch: 0n,
  };
  const domain: SaleIntentDomain = {
    chainId: 560048,
    verifyingContract: market,
  };
  const block = {
    number: 20n,
    hash: `0x${"ab".repeat(32)}` as const,
    timestamp: 1500n,
  };
  const state = { epoch: 0n as unknown, active: true };
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(
    async (args?: { blockNumber?: bigint; blockTag?: string }) => {
      void args;
      return { ...block };
    },
  );
  const readContract = vi.fn(async (args: unknown) => {
    void args;
    return state.epoch;
  });
  const client = {
    getChainId,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  const assertCurrent = vi.fn(() => {
    if (!state.active) throw new Error("session changed");
  });
  const verify = () =>
    kind === "whole"
      ? verifyWholeArtworkSigningState({
          client,
          intent: whole,
          domain,
          expectedChainId: 560048,
          assertCurrent,
        })
      : verifyFractionSigningState({
          client,
          intent: fraction,
          domain,
          expectedChainId: 560048,
          assertCurrent,
        });
  return {
    verify,
    client,
    getChainId,
    getBlock,
    readContract,
    assertCurrent,
    whole,
    fraction,
    original: kind === "whole" ? whole : fraction,
    domain,
    block,
    state,
  };
}
afterEach(() => vi.useRealTimers());

describe.each(["whole", "fraction"] as const)(
  "%s current sale signing state",
  (kind) => {
    it("allows existing terms at the same current epoch and canonical block", async () => {
      const f = fixture(kind);
      const snapshot = await f.verify();
      expect(snapshot.blockNumber).toBe(20n);
      expect(snapshot.timestamp).toBe(1500n);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(f.readContract).toHaveBeenCalledOnce();
      expect(f.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: market,
          functionName: "sellerEpoch",
          args: [seller],
          blockNumber: 20n,
        }),
      );
      expect(f.getBlock).toHaveBeenLastCalledWith({ blockNumber: 20n });
    });
    it("refuses an epoch changed by another wallet session before requesting a signature", async () => {
      const f = fixture(kind);
      f.state.epoch = 1n;
      const sign = vi.fn();
      await expect(
        (async () => {
          await f.verify();
          sign();
        })(),
      ).rejects.toThrow("seller epoch changed");
      expect(sign).not.toHaveBeenCalled();
    });
    it.each([999n, 2000n, 2001n])(
      "refuses a sale window not open at chain time %s",
      async (time) => {
        const f = fixture(kind);
        f.block.timestamp = time;
        await expect(f.verify()).rejects.toThrow(
          "sale window is not currently open",
        );
      },
    );
    it.each([undefined, null, 0, -1n, 1n << 256n])(
      "rejects an unavailable or malformed epoch %s",
      async (epoch) => {
        const f = fixture(kind);
        f.state.epoch = epoch;
        await expect(f.verify()).rejects.toThrow(
          "current seller epoch is unavailable",
        );
      },
    );
    it("does not accept a reorganization during the epoch lookup", async () => {
      const f = fixture(kind);
      f.getBlock
        .mockResolvedValueOnce({ ...f.block })
        .mockResolvedValueOnce({ ...f.block, hash: `0x${"cd".repeat(32)}` });
      await expect(f.verify()).rejects.toThrow("observed sale block changed");
    });
    it("rejects a chain switch before completing the check", async () => {
      const f = fixture(kind);
      f.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(8453);
      await expect(f.verify()).rejects.toThrow("observed sale block changed");
    });
    it("stops before a new block read if the session retires during the chain lookup", async () => {
      const f = fixture(kind);
      f.getChainId.mockImplementation(async () => {
        f.state.active = false;
        return 560048;
      });
      await expect(f.verify()).rejects.toThrow("session changed");
      expect(f.getBlock).not.toHaveBeenCalled();
      expect(f.readContract).not.toHaveBeenCalled();
    });
    it("stops before canonicality RPCs if the session retires during the epoch read", async () => {
      const f = fixture(kind);
      f.readContract.mockImplementation(async () => {
        f.state.active = false;
        return 0n;
      });
      await expect(f.verify()).rejects.toThrow("session changed");
      expect(f.getBlock).toHaveBeenCalledOnce();
    });
    it("does not let mutation across an await replace the captured epoch", async () => {
      const f = fixture(kind);
      f.getChainId.mockImplementation(async () => {
        f.original.epoch = 1n;
        f.state.epoch = 1n;
        return 560048;
      });
      await expect(f.verify()).rejects.toThrow("seller epoch changed");
    });
    it("keeps the original signing market when the caller changes its domain while waiting", async () => {
      const f = fixture(kind);
      f.getChainId.mockImplementation(async () => {
        f.domain.verifyingContract = asset;
        return 560048;
      });
      await f.verify();
      expect(f.readContract).toHaveBeenCalledOnce();
      expect(f.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: market }),
      );
    });
    it("retires a timed-out check without starting late block or epoch reads", async () => {
      vi.useFakeTimers();
      const f = fixture(kind);
      let release: ((chain: number) => void) | undefined;
      f.getChainId.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      );
      const outcome = expect(f.verify()).rejects.toThrow("preflight timed out");
      await vi.advanceTimersByTimeAsync(signedMarketPreflightTimeoutMs);
      await outcome;
      release?.(560048);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.getBlock).not.toHaveBeenCalled();
      expect(f.readContract).not.toHaveBeenCalled();
    });
  },
);
