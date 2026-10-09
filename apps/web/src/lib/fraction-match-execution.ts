import type {
  FractionMatch,
  ObservedFractionMatchPlan,
} from "./fraction-matching";

/** Execute only reviewed quantities; stop on the first failure without rematching or replaying. */
export async function executeFractionMatches(
  plan: ObservedFractionMatchPlan,
  actions: {
    assertCurrent: () => void;
    settle: (match: FractionMatch) => Promise<unknown>;
    onConfirmed: (match: FractionMatch, count: number) => void;
  },
) {
  for (const [index, match] of plan.matches.entries()) {
    actions.assertCurrent();
    await actions.settle(match);
    actions.assertCurrent();
    actions.onConfirmed(match, index + 1);
  }
}
