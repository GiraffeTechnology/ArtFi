import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import {
  verifyFractionSale,
  verifyWholeArtworkSale,
} from "./signed-market-preflight";

const seller = "0x1000000000000000000000000000000000000020" as const;
const buyer = "0x1000000000000000000000000000000000000010" as const;
const market = "0x1000000000000000000000000000000000000001" as const;
const token = "0x1000000000000000000000000000000000000002" as const;
const paymentToken = "0x1000000000000000000000000000000000000005" as const;
const domain = { chainId: 560048, verifyingContract: market };
const common = {
  seller,
  paymentToken,
  buyer: "0x0000000000000000000000000000000000000000" as const,
  salt: 1n,
  startsAt: 1000,
  endsAt: 2000,
  epoch: 0n,
};
const whole = { ...common, collection: token, tokenId: 1n, price: 123n };
const fraction = {
  ...common,
  assetToken: token,
  maxAmount: 10n,
  unitPrice: 41n,
};

function reader(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    getApproved: "0x0000000000000000000000000000000000000000",
    intentUsed: false,
    intentFilled: 0n,
    sellerEpoch: 0n,
    ownerOf: seller,
    isApprovedForAll: true,
    paused: false,
    allowedCollection: true,
    allowedAssetToken: true,
    allowedPaymentToken: true,
    balanceOf: 10n,
    allowance: 10n,
    pilotPaymentCap: 1000n,
    pilotPaymentUsed: 0n,
    ...overrides,
  };
  const readContract = vi.fn(
    async (input: { functionName: string; blockNumber: bigint }) => {
      if (!(input.functionName in values))
        throw new Error("Unexpected contract read");
      return values[input.functionName];
    },
  );
  const getCode = vi.fn(async () => "0x6000");
  const call = vi.fn(async () => ({ data: `0x1626ba7e${"00".repeat(28)}` }));
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(async () => ({ number: 100n, timestamp: 1500n }));
  return {
    client: {
      readContract,
      getCode,
      call,
      getChainId,
      getBlock,
    } as unknown as PublicClient,
    readContract,
    getCode,
    call,
    getChainId,
    getBlock,
  };
}

function wholeOptions(client: PublicClient) {
  return {
    client,
    intent: whole,
    domain,
    buyer,
    signature: "0x1234" as const,
    expectedChainId: 560048,
  };
}
function fractionOptions(client: PublicClient) {
  return {
    client,
    intent: fraction,
    domain,
    buyer,
    signature: "0x1234" as const,
    expectedChainId: 560048,
    amount: 3n,
  };
}

describe("signed market preflight", () => {
  it("verifies whole-artwork EIP-712 terms and every state read at one mined block", async () => {
    const mock = reader();
    const result = await verifyWholeArtworkSale(wholeOptions(mock.client));
    expect(result.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mock.getCode).toHaveBeenCalledWith({
      address: seller,
      blockNumber: 100n,
    });
    expect(mock.call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: seller,
        account: market,
        blockNumber: 100n,
      }),
    );
    expect(mock.readContract).toHaveBeenCalledTimes(8);
    for (const [call] of mock.readContract.mock.calls)
      expect(call.blockNumber).toBe(100n);
  });

  it.each(["whole", "fraction"])(
    "refuses an invalid %s signature before any state-dependent approval",
    async (kind) => {
      const mock = reader();
      mock.call.mockResolvedValue({ data: `0xffffffff${"00".repeat(28)}` });
      await expect(
        kind === "whole"
          ? verifyWholeArtworkSale(wholeOptions(mock.client))
          : verifyFractionSale(fractionOptions(mock.client)),
      ).rejects.toThrow(/signature is invalid/);
      expect(mock.readContract).not.toHaveBeenCalled();
    },
  );

  it("uses the same-block contract verifier for arbitrary EIP-1271 signature bytes", async () => {
    const mock = reader();
    await verifyWholeArtworkSale({
      ...wholeOptions(mock.client),
      signature: "0x",
    });
    expect(mock.getCode).toHaveBeenCalledWith({
      address: seller,
      blockNumber: 100n,
    });
    expect(mock.call).toHaveBeenCalled();
  });

  it.each([
    [{ intentUsed: true }, /settled or withdrawn/],
    [{ sellerEpoch: 1n }, /epoch has changed/],
    [{ ownerOf: buyer }, /no longer holds/],
    [{ isApprovedForAll: false }, /seller has not approved/],
    [{ allowedCollection: false }, /not currently available/],
    [{ allowedPaymentToken: false }, /not currently available/],
    [{ paused: true }, /not currently available/],
  ] as const)(
    "rejects stale or unfillable whole-artwork state case %#",
    async (overrides, error) => {
      const mock = reader(overrides);
      await expect(
        verifyWholeArtworkSale(wholeOptions(mock.client)),
      ).rejects.toThrow(error);
    },
  );

  it("accepts an existing token-specific approval without requiring operator approval", async () => {
    const mock = reader({ isApprovedForAll: false, getApproved: market });
    await expect(
      verifyWholeArtworkSale(wholeOptions(mock.client)),
    ).resolves.toEqual(expect.objectContaining({ blockNumber: 100n }));
  });

  it("uses chain time rather than browser time for expiration", async () => {
    const mock = reader();
    mock.getBlock.mockResolvedValue({ number: 101n, timestamp: 2000n });
    await expect(
      verifyWholeArtworkSale(wholeOptions(mock.client)),
    ).rejects.toThrow(/not open/);
  });

  it("rejects the wrong RPC chain before checking a signature", async () => {
    const mock = reader();
    mock.getChainId.mockResolvedValue(1);
    await expect(
      verifyWholeArtworkSale(wholeOptions(mock.client)),
    ).rejects.toThrow(/different chain/);
    expect(mock.call).not.toHaveBeenCalled();
  });

  it("keeps RPC errors closed", async () => {
    const mock = reader();
    mock.getCode.mockRejectedValue(new Error("RPC unavailable"));
    await expect(
      verifyWholeArtworkSale(wholeOptions(mock.client)),
    ).rejects.toThrow("RPC unavailable");
    expect(mock.readContract).not.toHaveBeenCalled();
  });

  it("accepts a bounded partial fill and reports its observed remainder", async () => {
    const mock = reader({ intentFilled: 4n });
    await expect(
      verifyFractionSale(fractionOptions(mock.client)),
    ).resolves.toEqual(
      expect.objectContaining({ remaining: 6n, blockNumber: 100n }),
    );
    expect(mock.readContract).toHaveBeenCalledTimes(9);
    for (const [call] of mock.readContract.mock.calls)
      expect(call.blockNumber).toBe(100n);
  });

  it.each([
    [{ intentFilled: 8n }, /insufficient remaining/],
    [{ intentFilled: 10n }, /insufficient remaining/],
    [{ sellerEpoch: 1n }, /insufficient remaining/],
    [{ balanceOf: 2n }, /balance or market allowance/],
    [{ allowance: 2n }, /balance or market allowance/],
    [{ allowedAssetToken: false }, /not currently available/],
    [{ allowedPaymentToken: false }, /not currently available/],
    [{ paused: true }, /not currently available/],
    [{ pilotPaymentUsed: 900n }, /pilot payment cap/],
    [{ pilotPaymentCap: 0n }, /pilot payment cap/],
    [{ pilotPaymentUsed: 1001n }, /pilot payment cap/],
  ] as const)(
    "rejects stale or unfillable fraction state case %#",
    async (overrides, error) => {
      const mock = reader(overrides);
      await expect(
        verifyFractionSale(fractionOptions(mock.client)),
      ).rejects.toThrow(error);
    },
  );

  it("refuses another named buyer before any RPC reads", async () => {
    const mock = reader();
    await expect(
      verifyWholeArtworkSale({
        ...wholeOptions(mock.client),
        intent: { ...whole, buyer: token },
      }),
    ).rejects.toThrow(/connected buyer/);
    expect(mock.getChainId).not.toHaveBeenCalled();
  });
});
