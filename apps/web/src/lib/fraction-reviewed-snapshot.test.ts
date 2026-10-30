import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { nativeOrderFromAuthorization } from "./native-order";
import {
  readFractionMatchPlan,
  planFractionMatches,
  type FractionMatchRequest,
  type ObservedFractionMatchPlan,
  type FractionMatch,
} from "./fraction-matching";
import { executeFractionMatches } from "./fraction-match-execution";
vi.mock("./market-signature", () => ({
  verifyMarketSignature: vi.fn(async () => true),
}));
const market = "0x1000000000000000000000000000000000000001",
  asset = "0x1000000000000000000000000000000000000002",
  payment = "0x1000000000000000000000000000000000000003",
  buyer = "0x1000000000000000000000000000000000000004",
  seller = "0x1000000000000000000000000000000000000005",
  other = "0x1000000000000000000000000000000000000006";
const block = {
    number: 100n,
    timestamp: 1500n,
    hash: `0x${"a".repeat(64)}` as const,
  },
  originalLog = `0x${"b".repeat(64)}` as const;
function order(salt = "1") {
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
          salt,
          startsAt: 1000,
          endsAt: 2000,
          epoch: "0",
        },
        signature: "0x",
      }),
      market,
    ),
    createdAt: "2026-10-19T00:00:00.000001Z",
  };
}
function setup() {
  const request: FractionMatchRequest = {
    market,
    asset,
    paymentToken: payment,
    buyer,
    amount: 5n,
    maxPayment: 20n,
    maxUnitPrice: 3n,
  };
  const body = {
    data: [order()],
    at: 1500,
    logHash: originalLog as string,
    priority: "price-time-hash",
  };
  const readContract = vi.fn(async (input: { functionName: string }) => {
    switch (input.functionName) {
      case "paused":
        return false;
      case "allowedAssetToken":
      case "allowedPaymentToken":
        return true;
      case "pilotPaymentCap":
      case "balanceOf":
      case "allowance":
        return 100n;
      case "pilotPaymentUsed":
      case "sellerEpoch":
      case "intentFilled":
        return 0n;
      default:
        throw Error(input.functionName);
    }
  });
  const methods = {
    getChainId: vi.fn(async () => 560048),
    getBlock: vi.fn(async () => ({ ...block })),
    readContract,
    getCode: vi.fn(),
    call: vi.fn(),
  };
  const client = methods as unknown as PublicClient;
  return { request, body, methods, client, load: vi.fn(async () => body) };
}
function twoMatches() {
  const orders = [order(), order("2")];
  const p = planFractionMatches({
    orders,
    request: {
      market,
      asset,
      paymentToken: payment,
      buyer,
      amount: 15n,
      maxPayment: 40n,
    },
    at: 1500n,
    paymentAvailable: 100n,
    liquidity: new Map(
      orders.map((o) => [
        o.intentHash,
        {
          filled: 0n,
          epoch: 0n,
          balance: 100n,
          allowance: 100n,
          signatureValid: true,
        },
      ]),
    ),
  });
  return {
    ...p,
    blockNumber: block.number,
    blockHash: block.hash,
    logHash: originalLog,
  } as ObservedFractionMatchPlan;
}
function mutablePlan() {
  return structuredClone(twoMatches()) as ObservedFractionMatchPlan;
}
afterEach(() => vi.restoreAllMocks());
describe("reviewed fraction snapshots", () => {
  it("fraction-snapshot regression input mutation never changes the captured request", async () => {
    const s = setup();
    s.methods.getChainId.mockImplementationOnce(async () => {
      s.request.market = other;
      s.request.asset = other;
      s.request.paymentToken = other;
      s.request.buyer = other;
      s.request.amount = 100n;
      s.request.maxPayment = 1n;
      s.request.maxUnitPrice = 1n;
      return 560048;
    });
    const result = await readFractionMatchPlan(s.client, s.request, s.load);
    expect(result.matched).toBe(5n);
    expect(result.payment).toBe(10n);
    expect(result.matches[0].intent.assetToken).toBe(asset);
    expect(
      s.methods.readContract.mock.calls.find(
        ([input]) => input.functionName === "pilotPaymentCap",
      )?.[0],
    ).toMatchObject({ address: market, args: [buyer, payment] });
  });
  it("fraction-snapshot regression later book mutation cannot replace the original log identity", async () => {
    const s = setup();
    const original = s.methods.readContract.getMockImplementation()!;
    s.methods.readContract.mockImplementation(async (input) => {
      s.body.logHash = `0x${"c".repeat(64)}`;
      s.body.data.splice(0);
      return original(input);
    });
    const result = await readFractionMatchPlan(s.client, s.request, s.load);
    expect(result.logHash).toBe(originalLog);
    expect(result.matched).toBe(5n);
  });
  it("fraction-snapshot regression execution ignores newly appended matches", async () => {
    const p = mutablePlan();
    const first = p.matches[0];
    const settle = vi.fn(async () => {
      if (settle.mock.calls.length === 1)
        (p.matches as FractionMatch[]).push(structuredClone(first));
    });
    await executeFractionMatches(p, {
      assertCurrent: () => {},
      settle,
      onConfirmed: () => {},
    });
    expect(settle).toHaveBeenCalledTimes(2);
  });
  it("fraction-snapshot regression execution keeps original nested terms and quantities", async () => {
    const p = mutablePlan();
    const expected = structuredClone(p.matches[1]);
    const seen: FractionMatch[] = [];
    await executeFractionMatches(p, {
      assertCurrent: () => {},
      settle: async (match) => {
        seen.push(structuredClone(match));
        if (seen.length === 1) {
          p.matches[1].amount = 99n;
          p.matches[1].payment = 999n;
          p.matches[1].intent.seller = other;
          p.matches[1].order.intent.unitPrice = "999";
          p.matches[1].order.signature = "0xab";
        }
      },
      onConfirmed: () => {},
    });
    expect(seen[1]).toEqual(expected);
  });
  it("freezes a produced plan and every supported nested sale object", () => {
    const p = twoMatches();
    expect(Object.isFrozen(p.matches)).toBe(true);
    expect(Object.isFrozen(p.matches[0])).toBe(true);
    expect(Object.isFrozen(p.matches[0].intent)).toBe(true);
    expect(Object.isFrozen(p.matches[0].order)).toBe(true);
    expect(Object.isFrozen(p.matches[0].order.intent)).toBe(true);
  });
  it("returns an immutable observed plan", async () => {
    const s = setup();
    const p = await readFractionMatchPlan(s.client, s.request, s.load);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.matches)).toBe(true);
  });
  it("detaches plan contents before the first current-context assertion", async () => {
    const p = mutablePlan();
    const original = structuredClone(p.matches[0]);
    let assertions = 0;
    const settled: FractionMatch[] = [];
    await executeFractionMatches(p, {
      assertCurrent: () => {
        if (assertions++ === 0) {
          p.matches[0].amount = 99n;
          p.matches[0].order.intent.maxAmount = "99";
        }
      },
      settle: async (match) => {
        settled.push(structuredClone(match));
      },
      onConfirmed: () => {},
    });
    expect(settled[0]).toEqual(original);
  });
  it("detaches the action callbacks before waiting for the first settlement", async () => {
    const p = mutablePlan();
    const replacement = vi.fn();
    const confirmed = vi.fn();
    const settle = vi.fn(async () => {
      actions.settle = replacement;
      actions.onConfirmed = replacement;
    });
    const actions = { assertCurrent: () => {}, settle, onConfirmed: confirmed };
    await executeFractionMatches(p, actions);
    expect(settle).toHaveBeenCalledTimes(2);
    expect(confirmed).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
  });
  it("stops if a settlement adapter attempts to mutate its captured sale", async () => {
    const p = mutablePlan();
    const confirmed = vi.fn();
    const settle = vi.fn(async (match: FractionMatch) => {
      match.intent.unitPrice = 999n;
    });
    await expect(
      executeFractionMatches(p, {
        assertCurrent: () => {},
        settle,
        onConfirmed: confirmed,
      }),
    ).rejects.toThrow();
    expect(settle).toHaveBeenCalledOnce();
    expect(confirmed).not.toHaveBeenCalled();
    expect(p.matches[0].intent.unitPrice).toBe(2n);
  });
  it("keeps confirmed-prefix notifications and stops on an unknown result without replay", async () => {
    const p = mutablePlan();
    const settle = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error("unknown outcome"));
    const confirmed = vi.fn();
    await expect(
      executeFractionMatches(p, {
        assertCurrent: () => {},
        settle,
        onConfirmed: confirmed,
      }),
    ).rejects.toThrow("unknown outcome");
    expect(settle).toHaveBeenCalledTimes(2);
    expect(confirmed).toHaveBeenCalledOnce();
    expect(confirmed.mock.calls[0][1]).toBe(1);
  });
});
