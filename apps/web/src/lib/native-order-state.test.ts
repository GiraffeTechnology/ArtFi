import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { nativeOrderFromAuthorization } from "./native-order";
import { readNativeOrderState } from "./native-order-state";

const market = "0x1000000000000000000000000000000000000001";
const seller = "0x1000000000000000000000000000000000000020";
const asset = "0x1000000000000000000000000000000000000002";
function fixture(
  kind: "whole" | "fraction",
  overrides: Record<string, unknown> = {},
) {
  const order = nativeOrderFromAuthorization(
    kind,
    JSON.stringify({
      intent: {
        seller,
        paymentToken: asset,
        buyer: "0x0000000000000000000000000000000000000000",
        salt: "1",
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
  const values = {
    sellerEpoch: 0n,
    intentFilled: 0n,
    intentUsed: false,
    ...overrides,
  } as Record<string, unknown>;
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string }) => values[functionName],
  );
  const getBlock = vi.fn(async () => ({ number: 50n, timestamp: 1500n }));
  const client = {
    getChainId: async () => 560048,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  return { order, client, readContract, getBlock };
}

describe("native order chain restoration", () => {
  it("reconstructs a partial fill after a new page load from the durable terms and chain counter", async () => {
    const f = fixture("fraction", { intentFilled: 4n });
    await expect(readNativeOrderState(f.client, f.order)).resolves.toEqual({
      label: "Partially filled",
      remaining: "6",
      blockNumber: "50",
    });
  });
  it("does not mislabel whole-artwork consumed authority as a proven sale", async () => {
    const f = fixture("whole", { intentUsed: true });
    await expect(readNativeOrderState(f.client, f.order)).resolves.toEqual({
      label: "Settled or withdrawn",
      remaining: "0",
      blockNumber: "50",
    });
  });
  it("does not mislabel a revoked fraction counter as sold quantity", async () => {
    const f = fixture("fraction", { intentFilled: 10n });
    await expect(readNativeOrderState(f.client, f.order)).resolves.toEqual({
      label: "No remaining authorization",
      remaining: "0",
      blockNumber: "50",
    });
  });
  it.each(["whole", "fraction"] as const)(
    "restores %s epoch withdrawal without a browser journal",
    async (kind) => {
      const f = fixture(kind, { sellerEpoch: 1n });
      await expect(readNativeOrderState(f.client, f.order)).resolves.toEqual({
        label: "Withdrawn by seller epoch",
        remaining: "0",
        blockNumber: "50",
      });
    },
  );
  it("does not turn an RPC outage into an open order", async () => {
    const f = fixture("whole");
    f.readContract.mockRejectedValue(new Error("RPC unavailable"));
    await expect(readNativeOrderState(f.client, f.order)).rejects.toThrow(
      "RPC unavailable",
    );
  });
  it("uses chain time to restore expiration", async () => {
    const f = fixture("whole");
    f.getBlock.mockResolvedValue({ number: 51n, timestamp: 2000n });
    await expect(
      readNativeOrderState(f.client, f.order),
    ).resolves.toMatchObject({ label: "Expired", blockNumber: "51" });
  });
});
