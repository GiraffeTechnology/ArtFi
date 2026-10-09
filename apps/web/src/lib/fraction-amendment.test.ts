import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  retireFractionForAmendment,
  freshFractionSalt,
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
    getBlock: vi.fn(async () => ({ number: 20n, timestamp: 1500n })),
    readContract,
  } as unknown as PublicClient;
  const revoke = vi.fn(async () => {
    consumed = 10n;
  });
  const assertCurrent = vi.fn();
  return { client, market, original, seller, revoke, assertCurrent } as const;
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
