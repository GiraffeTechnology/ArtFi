import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { nativeOrderFromAuthorization, type NativeOrder } from "./native-order";
import {
  planFractionMatches,
  rankFractionCandidates,
  readFractionMatchPlan,
  fractionBookReadTimeoutMs,
  type FractionLiquidity,
  type FractionMatchRequest,
} from "./fraction-matching";

vi.mock("./market-signature", () => ({
  verifyMarketSignature: vi.fn(async () => true),
}));
const market = "0x1000000000000000000000000000000000000001";
const asset = "0x1000000000000000000000000000000000000002";
const payment = "0x1000000000000000000000000000000000000003";
const buyer = "0x1000000000000000000000000000000000000004";
const seller = "0x1000000000000000000000000000000000000005";
const otherSeller = "0x1000000000000000000000000000000000000006";
const request: FractionMatchRequest = {
  market,
  asset,
  paymentToken: payment,
  buyer,
  amount: 10n,
  maxPayment: 100n,
};
function order(
  overrides: Record<string, string | number> = {},
  createdAt = "2026-10-05T00:00:00.000001Z",
) {
  return {
    ...nativeOrderFromAuthorization(
      "fraction",
      JSON.stringify({
        intent: {
          seller,
          assetToken: asset,
          paymentToken: payment,
          maxAmount: "10",
          unitPrice: "2",
          buyer: "0x0000000000000000000000000000000000000000",
          salt: "1",
          startsAt: 1000,
          endsAt: 2000,
          epoch: "0",
          ...overrides,
        },
        signature: "0x",
      }),
      market,
    ),
    createdAt,
  };
}
const state: FractionLiquidity = {
  filled: 0n,
  epoch: 0n,
  balance: 100n,
  allowance: 100n,
  signatureValid: true,
};
function plan(
  orders: NativeOrder[],
  options: {
    terms?: Partial<FractionMatchRequest>;
    states?: Partial<FractionLiquidity>[];
    budget?: bigint;
    at?: bigint;
  } = {},
) {
  return planFractionMatches({
    orders,
    request: { ...request, ...options.terms },
    at: options.at ?? 1500n,
    liquidity: new Map(
      orders.map((o, i) => [
        o.intentHash,
        { ...state, ...options.states?.[i] },
      ]),
    ),
    paymentAvailable: options.budget ?? 1000n,
  });
}

describe("deterministic noncustodial fraction matching", () => {
  it("uses numeric price, original microsecond time, then hash for exact ties", () => {
    const earlier = order(
      { unitPrice: "2", salt: "2" },
      "2026-10-05T00:00:00.000001Z",
    );
    const later = order(
      { unitPrice: "2", salt: "3" },
      "2026-10-05T00:00:00.000002Z",
    );
    const expensive = order(
      { unitPrice: "10", salt: "4" },
      "2026-10-04T00:00:00Z",
    );
    const tie = order({ unitPrice: "2", salt: "5" }, earlier.createdAt);
    const ranked = rankFractionCandidates(
      [expensive, later, tie, earlier],
      request,
    );
    expect(ranked.map((o) => o.order.intentHash)).toEqual(
      [earlier.intentHash, tie.intentHash]
        .sort()
        .concat(later.intentHash, expensive.intentHash),
    );
  });
  it("replays the same match regardless of input order and does not prioritize a seller", () => {
    const first = order({
      seller: otherSeller,
      maxAmount: "4",
      unitPrice: "1",
    });
    const second = order();
    const a = plan([second, first]);
    const b = plan([first, second]);
    expect(a).toEqual(b);
    expect(a.matches.map((m) => [m.intent.seller, m.amount])).toEqual([
      [otherSeller, 4n],
      [seller, 6n],
    ]);
    expect(a.payment).toBe(16n);
  });
  it("consumes only the remaining signed amount after cumulative partial fills", () => {
    const result = plan([order()], { states: [{ filled: 7n }] });
    expect(result.matched).toBe(3n);
    expect(result.unfilled).toBe(7n);
  });
  it.each([
    { filled: 10n },
    { filled: 100n },
    { epoch: 1n },
    { signatureValid: false },
    { allowance: 0n },
    { balance: 0n },
  ])(
    "does not match revoked, superseded, invalid, or unavailable authority: %o",
    (partial) => {
      expect(plan([order()], { states: [partial] }).matched).toBe(0n);
    },
  );
  it("excludes a self-trade and an order restricted to another buyer", () => {
    expect(
      plan([order({ seller: buyer }), order({ buyer: otherSeller, salt: "2" })])
        .matched,
    ).toBe(0n);
  });
  it("keeps startsAt inclusive and endsAt exclusive", () => {
    expect(plan([order()], { at: 999n }).matched).toBe(0n);
    expect(plan([order()], { at: 1000n }).matched).toBe(10n);
    expect(plan([order()], { at: 2000n }).matched).toBe(0n);
  });
  it("never promises the same seller's tokens or allowance across several intents twice", () => {
    const result = plan(
      [order({ maxAmount: "4", unitPrice: "1" }), order({ salt: "2" })],
      { states: [{ balance: 6n }, { balance: 6n }] },
    );
    expect(result.matched).toBe(6n);
    expect(result.matches.map((m) => m.amount)).toEqual([4n, 2n]);
  });
  it("respects user budget, available payment, limit price and leaves a truthful remainder", () => {
    expect(plan([order()], { terms: { maxPayment: 7n } }).matched).toBe(3n);
    expect(plan([order()], { budget: 5n }).matched).toBe(2n);
    expect(plan([order()], { terms: { maxUnitPrice: 1n } }).matched).toBe(0n);
  });
  it("handles uint256-sized prices without floating point or multiplication overflow", () => {
    const maximum = (1n << 256n) - 1n;
    const result = plan([order({ unitPrice: String(maximum) })], {
      terms: { maxPayment: maximum },
      budget: maximum,
    });
    expect(result.matched).toBe(1n);
    expect(result.payment).toBe(maximum);
  });
  it("rejects incomplete state instead of silently skipping the unavailable seller", () => {
    expect(() =>
      planFractionMatches({
        orders: [order()],
        request,
        at: 1500n,
        liquidity: new Map(),
        paymentAvailable: 100n,
      }),
    ).toThrow("chain state");
  });
  it("refuses a duplicate, wrong pair, missing authoritative time or invalid quantity", () => {
    const source = order();
    expect(() => plan([source, source])).toThrow("duplicate");
    expect(() => plan([order({ paymentToken: asset })])).toThrow(
      "different pair",
    );
    expect(() => plan([{ ...source, createdAt: undefined }])).toThrow(
      "publication time",
    );
    expect(() => plan([source], { terms: { amount: 0n } })).toThrow(
      "valid token pair",
    );
    expect(() => plan([source], { terms: { amount: 1n << 256n } })).toThrow(
      "valid token pair",
    );
  });
});

function reader(overrides: Record<string, unknown> = {}) {
  const getBlock = vi.fn(async () => ({
    number: 20n,
    timestamp: 1500n,
    hash: `0x${"a".repeat(64)}`,
  }));
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string }) =>
      ({
        paused: false,
        allowedAssetToken: true,
        allowedPaymentToken: true,
        pilotPaymentCap: 100n,
        pilotPaymentUsed: 0n,
        balanceOf: 100n,
        allowance: 100n,
        sellerEpoch: 0n,
        intentFilled: 0n,
        ...overrides,
      })[functionName],
  );
  const client = {
    getChainId: vi.fn(async () => 560048),
    getBlock,
    readContract,
  } as unknown as PublicClient;
  const loadBook = vi.fn(async () => ({
    data: [order()],
    at: 1500,
    priority: "price-time-hash",
    logHash: `0x${"b".repeat(64)}`,
  }));
  return { client, getBlock, readContract, loadBook };
}
describe("fraction match chain snapshot", () => {
  it("pins every read to one mined block, carries log/block evidence and checks reorgs", async () => {
    const f = reader();
    const result = await readFractionMatchPlan(f.client, request, f.loadBook);
    expect(result.matched).toBe(10n);
    expect(result.blockNumber).toBe(20n);
    expect(f.loadBook).toHaveBeenCalledWith(1500n);
    expect(f.getBlock).toHaveBeenLastCalledWith({ blockNumber: 20n });
    for (const [call] of f.readContract.mock.calls)
      expect(call).toMatchObject({ blockNumber: 20n });
  });
  it.each([
    { paused: true },
    { allowedAssetToken: false },
    { allowedPaymentToken: false },
  ])("fails closed for unavailable settlement: %o", async (values) => {
    const f = reader(values);
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("unavailable");
  });
  it("uses the buyer's remaining chain cap", async () => {
    const f = reader({ pilotPaymentUsed: 95n });
    expect(
      (await readFractionMatchPlan(f.client, request, f.loadBook)).matched,
    ).toBe(2n);
  });
  it("does not hide a failed RPC read", async () => {
    const f = reader();
    f.readContract.mockRejectedValue(new Error("RPC lost"));
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("RPC lost");
  });
  it("rejects a reorg during reads", async () => {
    const f = reader();
    f.getBlock.mockResolvedValueOnce({
      number: 20n,
      timestamp: 1500n,
      hash: `0x${"c".repeat(64)}`,
    });
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("observed block changed");
  });
  it("refuses a wrong-chain reader before fetching the order log", async () => {
    const f = reader();
    vi.mocked(f.client.getChainId).mockResolvedValue(1);
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("different chain");
    expect(f.loadBook).not.toHaveBeenCalled();
  });
  it("does not accept a silently partial or mismatched log snapshot", async () => {
    const f = reader();
    f.loadBook.mockResolvedValue({
      data: [order()],
      at: 1600,
      priority: "price-time-hash",
      logHash: `0x${"b".repeat(64)}`,
    });
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("incomplete or malformed");
  });
});

describe("fraction book bounded canonical observations", () => {
  it.each([
    { number: null },
    { number: -1n },
    { number: 20 },
    { timestamp: -1n },
    { timestamp: 1n << 48n },
    { timestamp: 1500 },
    { hash: "0x1234" },
    { hash: `0x${"0".repeat(64)}` },
  ])(
    "rejects a malformed initial block before loading orders: %o",
    async (partial) => {
      const f = reader();
      f.getBlock.mockResolvedValueOnce({
        number: 20n,
        timestamp: 1500n,
        hash: `0x${"a".repeat(64)}`,
        ...partial,
      } as never);
      await expect(
        readFractionMatchPlan(f.client, request, f.loadBook),
      ).rejects.toThrow("mined chain snapshot");
      expect(f.loadBook).not.toHaveBeenCalled();
    },
  );
  it.each([
    { paused: undefined },
    { paused: 0 },
    { allowedAssetToken: "true" },
    { allowedPaymentToken: 1 },
  ])("requires exact market booleans: %o", async (partial) => {
    const f = reader(partial);
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("unavailable");
  });
  it.each([
    { pilotPaymentCap: -1n },
    { pilotPaymentCap: 1n << 256n },
    { pilotPaymentUsed: undefined },
    { pilotPaymentUsed: "0" },
    { balanceOf: -1n },
    { balanceOf: 100 },
  ])("rejects malformed buyer payment state: %o", async (partial) => {
    const f = reader(partial);
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("payment state is invalid");
  });
  it.each([{ number: 21n }, { timestamp: 1501n }])(
    "rejects inconsistent final block fields even with the same hash: %o",
    async (partial) => {
      const f = reader();
      f.getBlock.mockResolvedValueOnce({
        number: 20n,
        timestamp: 1500n,
        hash: `0x${"a".repeat(64)}`,
      });
      f.getBlock.mockResolvedValueOnce({
        number: 20n,
        timestamp: 1500n,
        hash: `0x${"a".repeat(64)}`,
        ...partial,
      });
      await expect(
        readFractionMatchPlan(f.client, request, f.loadBook),
      ).rejects.toThrow("chain or observed block changed");
    },
  );
  it("rechecks the reader chain after every order and liquidity read", async () => {
    const f = reader();
    vi.mocked(f.client.getChainId)
      .mockResolvedValueOnce(560048)
      .mockResolvedValueOnce(1);
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("chain or observed block changed");
  });
  it("does not accept an unknown signature verdict as valid authority", () => {
    expect(() =>
      plan([order()], {
        states: [{ signatureValid: "true" as unknown as boolean }],
      }),
    ).toThrow("chain state is invalid");
  });
  it("does not accept an all-zero order-log digest", async () => {
    const f = reader();
    f.loadBook.mockResolvedValue({
      data: [order()],
      at: 1500,
      priority: "price-time-hash",
      logHash: `0x${"0".repeat(64)}`,
    });
    await expect(
      readFractionMatchPlan(f.client, request, f.loadBook),
    ).rejects.toThrow("incomplete or malformed");
  });
  it("retires a stalled initial RPC at the finite deadline without loading a book", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      vi.mocked(f.client.getChainId).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const failure = expect(
        readFractionMatchPlan(f.client, request, f.loadBook),
      ).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(fractionBookReadTimeoutMs);
      await failure;
      expect(f.loadBook).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not deliver a late complete preview after the order-log deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      let resolve!: (value: Awaited<ReturnType<typeof f.loadBook>>) => void;
      f.loadBook.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const success = vi.fn();
      const result = readFractionMatchPlan(f.client, request, f.loadBook).then(
        success,
      );
      const failure = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(fractionBookReadTimeoutMs);
      await failure;
      resolve({
        data: [order()],
        at: 1500,
        priority: "price-time-hash",
        logHash: `0x${"b".repeat(64)}`,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(success).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears the deadline after a successful complete read", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      expect(
        (await readFractionMatchPlan(f.client, request, f.loadBook)).matched,
      ).toBe(10n);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retired fraction-book work", () => {
  it("does not start a block read after the initial chain RPC resolves past the deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      let release!: (chainId: number) => void;
      vi.mocked(f.client.getChainId).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const result = readFractionMatchPlan(f.client, request, f.loadBook);
      const failure = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(fractionBookReadTimeoutMs);
      await failure;
      release(560048);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.getBlock).not.toHaveBeenCalled();
      expect(f.loadBook).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start liquidity RPCs after a retired order-log response arrives", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      let release!: (book: Awaited<ReturnType<typeof f.loadBook>>) => void;
      f.loadBook.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const result = readFractionMatchPlan(f.client, request, f.loadBook);
      const failure = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(fractionBookReadTimeoutMs);
      await failure;
      release({
        data: [order()],
        at: 1500,
        priority: "price-time-hash",
        logHash: `0x${"b".repeat(64)}`,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.readContract).not.toHaveBeenCalled();
      expect(f.getBlock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not launch a ninth candidate or final canonical reads when the first batch finishes late", async () => {
    vi.useFakeTimers();
    try {
      const f = reader();
      f.loadBook.mockResolvedValue({
        data: Array.from({ length: 9 }, (_, i) =>
          order({ salt: String(i + 1) }),
        ),
        at: 1500,
        priority: "price-time-hash",
        logHash: `0x${"b".repeat(64)}`,
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = f.readContract.getMockImplementation()!;
      f.readContract.mockImplementation(async (input) => {
        if (input.functionName === "intentFilled") await held;
        return original(input);
      });
      const result = readFractionMatchPlan(f.client, request, f.loadBook);
      const failure = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.readContract.mock.calls.filter(
          ([x]) => x.functionName === "intentFilled",
        ),
      ).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(fractionBookReadTimeoutMs);
      await failure;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.readContract.mock.calls.filter(
          ([x]) => x.functionName === "intentFilled",
        ),
      ).toHaveLength(8);
      expect(f.getBlock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.client.getChainId)).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
