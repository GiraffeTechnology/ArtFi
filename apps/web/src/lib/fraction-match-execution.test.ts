import { describe, expect, it, vi } from "vitest";
import { executeFractionMatches } from "./fraction-match-execution";
import type {
  FractionMatch,
  ObservedFractionMatchPlan,
} from "./fraction-matching";
const matches = [
  { amount: 2n, payment: 4n },
  { amount: 3n, payment: 9n },
] as FractionMatch[];
const plan = { matches } as ObservedFractionMatchPlan;
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
