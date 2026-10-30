import { snapshotFractionMatches } from "./fraction-match-snapshot";
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
  const matches = snapshotFractionMatches(plan.matches);
  const { assertCurrent, settle, onConfirmed } = actions;
  for (const [index, match] of matches.entries()) {
    assertCurrent();
    await settle(match);
    assertCurrent();
    onConfirmed(match, index + 1);
  }
}
