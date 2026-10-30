import type { FractionMatch } from "./fraction-matching";

/** Detach all supported sale fields before an asynchronous callback can change them. */
export function snapshotFractionMatches(
  matches: readonly FractionMatch[],
): readonly FractionMatch[] {
  return Object.freeze(
    matches.map((match) =>
      Object.freeze({
        ...match,
        order: Object.freeze({
          ...match.order,
          intent: Object.freeze({ ...match.order.intent }),
        }),
        intent: Object.freeze({ ...match.intent }),
      }),
    ),
  );
}
