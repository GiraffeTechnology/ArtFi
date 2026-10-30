/**
 * Charity-edition rights disclosure — #110 §2 CH.8.
 *
 * CH.8 requires this wherever an edition is displayed or offered, and `ACCEPTANCE.md` §7.17 fails
 * the audit when an edition appears without it. It is a single component precisely so that every
 * surface states the same thing: a buyer should not have to reconcile two wordings of what they are
 * not getting.
 *
 * The text states only what is true under CH.8 and CH.9. It promises no receipt, no eligible
 * amount and no tax credit, because ArtFi determines none of those — CCHS does.
 */

export const charityEditionRightsStatements = [
  "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
  "The only holder benefit is a high-resolution watermarked copy, released after wallet ownership is verified.",
  "All primary proceeds are designated for CCHS. Contact CCHS directly about any donation receipt.",
  "ArtFi issues no receipt, determines no eligible amount, and promises no tax credit.",
] as const;

export function CharityEditionRightsNotice({
  className,
}: {
  className?: string;
}) {
  return (
    <section
      aria-label="Charity edition rights and receipt boundary"
      data-testid="charity-edition-rights-notice"
      className={className}
    >
      <h3>What this edition is, and is not</h3>
      <ul>
        {charityEditionRightsStatements.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>
    </section>
  );
}
