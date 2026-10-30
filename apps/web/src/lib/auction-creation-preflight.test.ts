import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
const source = vi.hoisted(() => ({
  verify: vi.fn(async (_input: unknown) => undefined),
}));
vi.mock("./rwa-catalog", () => ({
  assertRwaTradingEvidence: source.verify,
}));
import {
  auctionCreationPreflight,
  createReviewedAuctionAtWallet,
  type AuctionCreationReader,
  type AuctionCreationReview,
} from "./auction-creation-preflight";

const a = (n: string) => ("0x" + n.repeat(40)) as Address;
const h = (n: string) => ("0x" + n.repeat(64)) as Hex;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// TEST_ONLY chain, source and wallet functions. No real grant/RPC/transaction.
function fixture() {
  const review = {
    market: a("1"),
    seller: a("2"),
    asset: a("3"),
    payment: a("4"),
    requestId: h("5"),
    amount: 4n,
    opening: 2n,
    reserve: 3n,
    increment: 1n,
    starts: 100,
    ends: 200,
    extension: 20,
    sourceSlug: "test-only-fractions",
    sourceIdentity: "opaque-existing-source-identity",
  } satisfies AuctionCreationReview;
  const state = {
    chain: 560048,
    switchChain: false,
    chainReads: 0,
    balance: 9n as unknown,
    allowance: 4n as unknown,
    allowedAsset: true as unknown,
    allowedPayment: true as unknown,
    paused: false as unknown,
    timestamp: 150n,
    orphan: false,
    sourceActive: true,
    current: true,
    reads: [] as Array<{ functionName: string; blockNumber?: bigint }>,
    blockWait: undefined as undefined | Promise<void>,
  };
  source.verify.mockReset();
  source.verify.mockImplementation(async () => {
    if (!state.sourceActive) throw Error("PRIVATE_SOURCE_DIAGNOSTIC");
  });
  const getChainId = vi.fn(async () => {
    state.chainReads++;
    return state.switchChain && state.chainReads > 1 ? 1 : state.chain;
  });
  const getBlock = vi.fn(async (input?: { blockNumber?: bigint }) => {
    await state.blockWait;
    return {
      number: 10n,
      hash: input && state.orphan ? h("9") : h("a"),
      timestamp: state.timestamp,
    };
  });
  const readContract = vi.fn(
    async (input: { functionName: string; blockNumber?: bigint }) => {
      state.reads.push(input);
      switch (input.functionName) {
        case "allowedAssetToken":
          return state.allowedAsset;
        case "allowedPaymentToken":
          return state.allowedPayment;
        case "paused":
          return state.paused;
        case "balanceOf":
          return state.balance;
        case "allowance":
          return state.allowance;
        default:
          throw Error("Unexpected read");
      }
    },
  );
  const client = {
    getChainId,
    getBlock,
    readContract,
  } as unknown as AuctionCreationReader;
  const assertCurrent = () => {
    if (!state.current) throw Error("Screen retired");
  };
  const prepared = Object.freeze({
    request: "original-synthetic-simulation-request",
  });
  const simulate = vi.fn(async (_review: AuctionCreationReview) => prepared);
  const submit = vi.fn(async (_request: typeof prepared) => h("b"));
  const steps = { assertCurrent, simulate, submit };
  return {
    review,
    state,
    client,
    getChainId,
    getBlock,
    readContract,
    assertCurrent,
    prepared,
    steps,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("auction creation checks inside the original wallet callback", () => {
  it("permits the exact approval before its allowance exists", async () => {
    const f = fixture();
    f.state.allowance = 0n;
    expect(
      await auctionCreationPreflight(
        f.client,
        f.review,
        "approval",
        f.assertCurrent,
      ),
    ).toEqual({ allowance: 0n });
    expect(source.verify).toHaveBeenCalledWith({
      section: "fractional",
      chainId: 560048,
      marketAddress: f.review.market,
      fractionTokenAddress: f.review.asset,
      slug: f.review.sourceSlug,
      identity: f.review.sourceIdentity,
    });
    expect(f.state.reads).toHaveLength(5);
    expect(f.state.reads.every((x) => x.blockNumber === 10n)).toBe(true);
  });
  it("requires sufficient current allowance for creation", async () => {
    const f = fixture();
    f.state.allowance = 0n;
    await expect(
      createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    ).rejects.toThrow("allowance");
    expect(f.steps.simulate).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
  });
  it("rechecks source and canonical state after simulation and preserves the original request", async () => {
    const f = fixture();
    expect(
      await createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    ).toBe(h("b"));
    expect(source.verify).toHaveBeenCalledTimes(2);
    expect(f.steps.simulate).toHaveBeenCalledTimes(1);
    expect(f.steps.submit).toHaveBeenCalledTimes(1);
    expect(f.steps.submit).toHaveBeenCalledWith(f.prepared);
    expect(f.state.reads).toHaveLength(10);
    expect(f.getBlock).toHaveBeenCalledTimes(4);
    expect(f.steps.simulate.mock.calls[0][0]).toEqual(f.review);
  });
  it("does not invent a future-start requirement for already-open reviewed terms", async () => {
    const f = fixture();
    expect(BigInt(f.review.starts)).toBeLessThan(f.state.timestamp);
    await expect(
      createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    ).resolves.toBe(h("b"));
  });
  it("observes source revocation during the original asynchronous gate before simulation", async () => {
    const f = fixture(),
      gate = deferred<void>();
    const flight = gate.promise.then(() =>
      createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    );
    f.state.sourceActive = false;
    gate.resolve();
    await expect(flight).rejects.toThrow("unavailable");
    expect(f.steps.simulate).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
  });
  it.each(["source", "pause", "balance", "allowance"] as const)(
    "stops a %s change while simulation was pending without a wallet call",
    async (changed) => {
      const f = fixture();
      f.steps.simulate.mockImplementation(async () => {
        if (changed === "source") f.state.sourceActive = false;
        if (changed === "pause") f.state.paused = true;
        if (changed === "balance") f.state.balance = 3n;
        if (changed === "allowance") f.state.allowance = 3n;
        return f.prepared;
      });
      await expect(
        createReviewedAuctionAtWallet(f.client, f.review, f.steps),
      ).rejects.toThrow();
      expect(f.steps.simulate).toHaveBeenCalledTimes(1);
      expect(f.steps.submit).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["asset permission", "allowedAsset", false],
    ["payment permission", "allowedPayment", false],
    ["pause", "paused", true],
    ["balance", "balance", 3n],
    ["malformed balance", "balance", "9"],
    ["malformed allowance", "allowance", -1n],
  ] as const)(
    "refuses invalid current %s before simulation",
    async (_name, key, value) => {
      const f = fixture();
      Object.assign(f.state, { [key]: value });
      await expect(
        createReviewedAuctionAtWallet(f.client, f.review, f.steps),
      ).rejects.toThrow();
      expect(f.steps.simulate).not.toHaveBeenCalled();
      expect(f.steps.submit).not.toHaveBeenCalled();
    },
  );
  it("refuses an auction that ended while waiting for authentication", async () => {
    const f = fixture();
    f.state.timestamp = 200n;
    await expect(
      createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    ).rejects.toThrow("ended");
    expect(f.readContract).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
  });
  it("rejects a wrong or switched chain", async () => {
    for (const changed of ["initial", "later"]) {
      const f = fixture();
      if (changed === "initial") f.state.chain = 1;
      else f.state.switchChain = true;
      await expect(
        createReviewedAuctionAtWallet(f.client, f.review, f.steps),
      ).rejects.toThrow("chain");
      expect(f.steps.simulate).not.toHaveBeenCalled();
      expect(f.steps.submit).not.toHaveBeenCalled();
    }
  });
  it("refuses a replaced source block", async () => {
    const f = fixture();
    f.state.orphan = true;
    await expect(
      createReviewedAuctionAtWallet(f.client, f.review, f.steps),
    ).rejects.toThrow("block changed");
    expect(f.steps.simulate).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
  });
  it("retires a cancelled read before later provider/source/wallet actions", async () => {
    const f = fixture(),
      blocked = deferred<void>();
    f.state.blockWait = blocked.promise;
    const flight = createReviewedAuctionAtWallet(f.client, f.review, f.steps);
    await Promise.resolve();
    await Promise.resolve();
    f.state.current = false;
    blocked.resolve();
    await expect(flight).rejects.toThrow("unavailable");
    expect(f.readContract).not.toHaveBeenCalled();
    expect(source.verify).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
  });
  it("retires late read results after the bounded deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      blocked = deferred<void>();
    f.state.blockWait = blocked.promise;
    const flight = createReviewedAuctionAtWallet(f.client, f.review, f.steps);
    const rejection = expect(flight).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    blocked.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.readContract).not.toHaveBeenCalled();
    expect(source.verify).not.toHaveBeenCalled();
    expect(f.steps.submit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("detaches the original review from mutation across simulation", async () => {
    const f = fixture();
    const original = { ...f.review };
    f.steps.simulate.mockImplementation(async (reviewed) => {
      expect(Object.isFrozen(reviewed)).toBe(true);
      f.review.amount = 8n;
      f.review.sourceIdentity = "changed";
      f.review.asset = a("8");
      return f.prepared;
    });
    await createReviewedAuctionAtWallet(f.client, f.review, f.steps);
    expect(f.steps.simulate.mock.calls[0][0]).toEqual(original);
    expect(source.verify.mock.calls[1][0]).toMatchObject({
      fractionTokenAddress: original.asset,
      identity: original.sourceIdentity,
    });
    expect(f.steps.submit).toHaveBeenCalledTimes(1);
    expect(f.steps.submit).toHaveBeenCalledWith(f.prepared);
  });
  it("keeps unexpected RPC and simulation diagnostics out of the user-facing failure", async () => {
    for (const failed of ["rpc", "simulation"]) {
      const f = fixture();
      const raw =
        "PRIVATE_DIAGNOSTIC https://provider.invalid/path?credential=TEST_ONLY";
      if (failed === "rpc") f.getChainId.mockRejectedValueOnce(Error(raw));
      else f.steps.simulate.mockRejectedValueOnce(Error(raw));
      try {
        await createReviewedAuctionAtWallet(f.client, f.review, f.steps);
        throw Error("Accepted");
      } catch (error) {
        expect(String(error)).not.toContain(raw);
        expect(String(error)).toContain("unavailable");
      }
      expect(f.steps.submit).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["zero amount", { amount: 0n }],
    ["uint256 overflow", { amount: 1n << 256n }],
    ["bad request", { requestId: h("0") }],
    ["reserve below opening", { reserve: 1n }],
    ["empty interval", { ends: 100 }],
    ["invalid uint48", { ends: 2 ** 48 }],
    ["excessive extension", { extension: 101 }],
    ["missing source identity", { sourceIdentity: "" }],
  ] as const)(
    "refuses %s reviewed terms before network or wallet calls",
    async (_name, change) => {
      const f = fixture();
      await expect(
        createReviewedAuctionAtWallet(
          f.client,
          { ...f.review, ...change },
          f.steps,
        ),
      ).rejects.toThrow();
      expect(f.getChainId).not.toHaveBeenCalled();
      expect(source.verify).not.toHaveBeenCalled();
      expect(f.steps.submit).not.toHaveBeenCalled();
    },
  );
});
