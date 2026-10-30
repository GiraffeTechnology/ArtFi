import {
  nativeOrderFromAuthorization,
  decodeNativeOrder,
} from "./native-order";
import { describe, expect, it, vi } from "vitest";
import { executeFractionMatches } from "./fraction-match-execution";
import type {
  FractionMatch,
  ObservedFractionMatchPlan,
} from "./fraction-matching";
const matches = [
  { amount: 2n, payment: 4n, price: "2", salt: "1" },
  { amount: 3n, payment: 9n, price: "3", salt: "2" },
].map(({ amount, payment, price, salt }) => {
  const order = nativeOrderFromAuthorization(
    "fraction",
    JSON.stringify({
      intent: {
        seller: "0x1000000000000000000000000000000000000005",
        assetToken: "0x1000000000000000000000000000000000000002",
        paymentToken: "0x1000000000000000000000000000000000000003",
        maxAmount: "10",
        unitPrice: price,
        buyer: "0x0000000000000000000000000000000000000000",
        salt,
        startsAt: 1000,
        endsAt: 2000,
        epoch: "0",
      },
      signature: "0x",
    }),
    "0x1000000000000000000000000000000000000001",
  );
  const decoded = decodeNativeOrder(order);
  if (decoded.kind !== "fraction")
    throw new Error("Expected a fraction fixture.");
  return { order: decoded.order, intent: decoded.intent, amount, payment };
});
const plan: ObservedFractionMatchPlan = {
  matches,
  requested: 5n,
  matched: 5n,
  unfilled: 0n,
  payment: 13n,
  blockNumber: 100n,
  blockHash: `0x${"a".repeat(64)}`,
  logHash: `0x${"b".repeat(64)}`,
};
describe("reviewed multi-fill execution", () => {
  it("settles sequentially without replacing the reviewed terms", async () => {
    const actions = {
      assertCurrent: vi.fn(),
      settle: vi
        .fn<(match: FractionMatch) => Promise<void>>()
        .mockResolvedValue(undefined),
      onConfirmed: vi.fn(),
    };
    await executeFractionMatches(plan, actions);
    expect(actions.settle.mock.calls.map(([match]) => match)).toEqual(matches);
    expect(actions.onConfirmed.mock.calls).toEqual([
      [matches[0], 1],
      [matches[1], 2],
    ]);
  });
  it("stops after a partial completion and never replays confirmed fills", async () => {
    const actions = {
      assertCurrent: vi.fn(),
      settle: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("revoked")),
      onConfirmed: vi.fn(),
    };
    await expect(executeFractionMatches(plan, actions)).rejects.toThrow(
      "revoked",
    );
    expect(actions.settle).toHaveBeenCalledTimes(2);
    expect(actions.onConfirmed).toHaveBeenCalledTimes(1);
  });
  it("stops on a session, wallet, terms or navigation change between confirmations", async () => {
    let current = true;
    const actions = {
      assertCurrent: () => {
        if (!current) throw new Error("context changed");
      },
      settle: vi
        .fn<(match: FractionMatch) => Promise<void>>()
        .mockResolvedValue(undefined),
      onConfirmed: vi.fn(() => {
        current = false;
      }),
    };
    await expect(executeFractionMatches(plan, actions)).rejects.toThrow(
      "context changed",
    );
    expect(actions.settle).toHaveBeenCalledTimes(1);
  });
});
