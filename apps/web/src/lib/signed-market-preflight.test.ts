import { testReceipt, testReceiptClient } from "./market-receipt-test-client";
import { describe, expect, it, vi } from "vitest";
import type { PublicClient, Hash } from "viem";
import {
  settleConfirmedSale,
  MarketReceiptPendingError,
} from "./market-transaction";

import {
  signedMarketPreflightTimeoutMs,
  verifyFractionSale,
  verifyWholeArtworkSale,
} from "./signed-market-preflight";

const seller = "0x1000000000000000000000000000000000000020" as const;
const buyer = "0x1000000000000000000000000000000000000010" as const;
const market = "0x1000000000000000000000000000000000000001" as const;
const token = "0x1000000000000000000000000000000000000002" as const;
const paymentToken = "0x1000000000000000000000000000000000000005" as const;
const blockHash = `0x${"ab".repeat(32)}` as const;
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
    paymentBalance: 10000n,
    allowance: 10n,
    pilotPaymentCap: 1000n,
    pilotPaymentUsed: 0n,
    ...overrides,
  };
  const readContract = vi.fn(
    async (input: {
      functionName: string;
      blockNumber: bigint;
      address?: string;
      args?: readonly unknown[];
    }) => {
      if (!(input.functionName in values))
        throw new Error("Unexpected contract read");
      if (
        input.functionName === "balanceOf" &&
        input.address === paymentToken &&
        input.args?.[0] === buyer
      )
        return values.paymentBalance;
      return values[input.functionName];
    },
  );
  const getCode = vi.fn(async () => "0x6000");
  const call = vi.fn(async () => ({ data: `0x1626ba7e${"00".repeat(28)}` }));
  const getChainId = vi.fn(async () => 560048);
  const getBlock = vi.fn(async () => ({
    number: 100n,
    hash: blockHash,
    timestamp: 1500n,
  }));
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
    change: (next: Record<string, unknown>) => Object.assign(values, next),
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
    expect(mock.readContract).toHaveBeenCalledTimes(9);
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
    [{ ownerOf: buyer }, /no longer the token owner/],
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
    mock.getBlock.mockResolvedValue({
      number: 101n,
      hash: blockHash,
      timestamp: 2000n,
    });
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
    expect(mock.readContract).toHaveBeenCalledTimes(10);
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

describe.each(["whole", "fraction"] as const)(
  "%s payment and canonical observation",
  (kind) => {
    const run = (mock: ReturnType<typeof reader>) =>
      kind === "whole"
        ? verifyWholeArtworkSale(wholeOptions(mock.client))
        : verifyFractionSale(fractionOptions(mock.client));
    it("reads the exact buyer payment balance at the same snapshot as sale authority", async () => {
      const mock = reader({ paymentBalance: 123n });
      const result = await run(mock);
      expect(result.blockHash).toBe(blockHash);
      expect(mock.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: paymentToken,
          functionName: "balanceOf",
          args: [buyer],
          blockNumber: 100n,
        }),
      );
      expect(mock.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n });
      expect(mock.getChainId).toHaveBeenCalledTimes(2);
    });
    it.each([0n, 122n, -1n, 1n << 256n, undefined, "123"])(
      "refuses insufficient or invalid observed payment balance %s",
      async (paymentBalance) => {
        const mock = reader({ paymentBalance });
        await expect(run(mock)).rejects.toThrow(/buyer.*payment-token balance/);
      },
    );
    it("does not require a pre-existing buyer allowance before asking for an exact approval", async () => {
      const mock = reader();
      await run(mock);
      expect(
        mock.readContract.mock.calls.some(
          ([input]) =>
            input.address === paymentToken &&
            input.functionName === "allowance",
        ),
      ).toBe(false);
    });
    it.each([
      { hash: `0x${"cd".repeat(32)}` },
      { number: 99n },
      { timestamp: 1499n },
    ])(
      "refuses a changed end-of-read canonical block case %#",
      async (change) => {
        const mock = reader();
        mock.getBlock.mockResolvedValueOnce({
          number: 100n,
          hash: blockHash,
          timestamp: 1500n,
        });
        mock.getBlock.mockResolvedValueOnce({
          number: 100n,
          hash: blockHash,
          timestamp: 1500n,
          ...change,
        } as never);
        await expect(run(mock)).rejects.toThrow(/observed sale block changed/);
      },
    );
    it("refuses a reader that changes chain after state and signature reads", async () => {
      const mock = reader();
      mock.getChainId.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
      await expect(run(mock)).rejects.toThrow(/chain.*changed/);
    });
    it.each([
      { number: null },
      { number: -1n },
      { hash: null },
      { hash: "0x1234" },
      { hash: `0x${"00".repeat(32)}` },
      { timestamp: -1n },
      { timestamp: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    ])("rejects unavailable initial block evidence case %#", async (change) => {
      const mock = reader();
      mock.getBlock.mockResolvedValue({
        number: 100n,
        hash: blockHash,
        timestamp: 1500n,
        ...change,
      } as never);
      await expect(run(mock)).rejects.toThrow(/mined block/);
      expect(mock.getCode).not.toHaveBeenCalled();
    });
    it("does not hide a failed buyer payment-token balance read", async () => {
      const mock = reader();
      const original = mock.readContract.getMockImplementation()!;
      mock.readContract.mockImplementation(async (input) => {
        if (
          input.address === paymentToken &&
          input.functionName === "balanceOf"
        )
          throw Error("TEST_ONLY payment read unavailable");
        return original(input);
      });
      await expect(run(mock)).rejects.toThrow(/payment read unavailable/);
    });
    it("retires a hanging RPC at the finite deadline without a late successful result", async () => {
      vi.useFakeTimers();
      try {
        const mock = reader();
        let release!: (value: number) => void;
        mock.getChainId.mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              release = resolve;
            }),
        );
        const outcome = run(mock).then(
          () => "unexpected success",
          (error) => String(error),
        );
        await vi.advanceTimersByTimeAsync(signedMarketPreflightTimeoutMs);
        expect(await outcome).toMatch(/timed out/);
        release(560048);
        await vi.runAllTimersAsync();
        expect(await outcome).toMatch(/timed out/);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it("clears its deadline timer on a completed observation", async () => {
      vi.useFakeTimers();
      try {
        await run(reader());
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);

describe.each(["whole", "fraction"] as const)(
  "%s approval-to-fill reads",
  (kind) => {
    const approvalHash = `0x${"01".repeat(32)}` as Hash;
    const fillHash = `0x${"02".repeat(32)}` as Hash;
    function flow(
      changeAfterApproval?: (mock: ReturnType<typeof reader>) => void,
      unknown = false,
      initialBalance = 123n,
    ) {
      const mock = reader({ paymentBalance: initialBalance });
      const preflight = () =>
        kind === "whole"
          ? verifyWholeArtworkSale(wholeOptions(mock.client))
          : verifyFractionSale(fractionOptions(mock.client));
      const submitApproval = vi.fn(async () => approvalHash);
      const submitFill = vi.fn(async () => fillHash);
      const approve = vi.fn(async () => {
        await preflight();
        return submitApproval();
      });
      const fill = vi.fn(async () => {
        await preflight();
        return submitFill();
      });
      const wait = vi.fn(async ({ hash }: { hash: Hash }) => {
        if (unknown) throw Error("TEST_ONLY receipt unavailable");
        if (hash === approvalHash) {
          mock.getBlock.mockResolvedValue({
            number: 101n,
            hash: `0x${"cd".repeat(32)}`,
            timestamp: 1501n,
          });
          changeAfterApproval?.(mock);
        }
        return testReceipt(hash);
      });
      const run = () =>
        settleConfirmedSale({
          client: testReceiptClient(wait),
          approvePayment: approve,
          settle: fill,
          onStage: () => {},
        });
      return { mock, approve, fill, submitApproval, submitFill, wait, run };
    }
    it("does not reach approval when current payment funds are insufficient", async () => {
      const f = flow(undefined, false, 122n);
      await expect(f.run()).rejects.toThrow(/payment-token balance/);
      expect(f.submitApproval).not.toHaveBeenCalled();
      expect(f.wait).not.toHaveBeenCalled();
      expect(f.fill).not.toHaveBeenCalled();
    });
    it("checks current terms again after approval and refuses a now-insufficient balance", async () => {
      const f = flow((mock) => mock.change({ paymentBalance: 122n }));
      await expect(f.run()).rejects.toThrow(/payment-token balance/);
      expect(f.submitApproval).toHaveBeenCalledTimes(1);
      expect(f.fill).toHaveBeenCalledTimes(1);
      expect(f.submitFill).not.toHaveBeenCalled();
      expect(f.wait).toHaveBeenCalledTimes(1);
    });
    it("keeps the original seller revocation check after a confirmed approval", async () => {
      const f = flow((mock) => mock.change({ sellerEpoch: 1n }));
      await expect(f.run()).rejects.toThrow(
        /epoch has changed|insufficient remaining/,
      );
      expect(f.wait).toHaveBeenCalledTimes(1);
    });
    it("does not proceed to a second preflight when the approval receipt is UNKNOWN", async () => {
      const f = flow(undefined, true);
      await expect(f.run()).rejects.toBeInstanceOf(MarketReceiptPendingError);
      expect(f.submitApproval).toHaveBeenCalledTimes(1);
      expect(f.fill).not.toHaveBeenCalled();
      expect(f.mock.getChainId).toHaveBeenCalledTimes(2);
    });
    it("continues the same signed terms after both current observations pass", async () => {
      const f = flow();
      await expect(f.run()).resolves.toMatchObject({
        status: "success",
        transactionHash: fillHash,
      });
      expect(f.submitApproval).toHaveBeenCalledTimes(1);
      expect(f.submitFill).toHaveBeenCalledTimes(1);
      expect(f.wait).toHaveBeenCalledTimes(2);
      expect(f.mock.getChainId).toHaveBeenCalledTimes(4);
    });
  },
);
