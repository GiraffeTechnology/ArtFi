/**
 * Prototype-data disclosure — `AGENTS.md` §5 and `ACCEPTANCE.md` §3, §7.5, §7.7.
 *
 * The artwork catalogue on these surfaces is `lib/catalog.ts`: six invented works by six invented
 * artists, with invented valuations and provenance. That is legitimate as inherited prototype
 * material — `PRD.md` §2.1 says to preserve Class A surfaces, not rebuild them — and it is **not**
 * legitimate to let a reader mistake it for a live catalogue. `ACCEPTANCE.md` §3 excludes fixture
 * data presented as live, and §7.7 fails an audit that describes mock evidence as current runtime
 * delivery. Until now nothing on the page said which it was.
 *
 * One component so every such surface says the same thing, for the same reason the charity rights
 * notice is one component: a reader should not have to reconcile two wordings of what is real.
 *
 * This discloses; it does not fix. M3.7 — the real catalogue replacing these fixtures — stays
 * `NOT-IMPLEMENTED`, and this notice is not evidence toward it.
 */

export const prototypeDataStatements = [
  "The artworks, artists, valuations and provenance on this surface are prototype fixtures carried over from the inherited prototype.",
  "They are not a live catalogue, not an observed market value, and not evidence of any asset held or registered.",
  "Runtime data appears only where a surface says it was observed, with its source and the time it was seen.",
] as const;

export function PrototypeDataNotice({ className }: { className?: string }) {
  return (
    <aside
      aria-label="Prototype data disclosure"
      className={className ?? "prototype-notice"}
      data-testid="prototype-data-notice"
    >
      <strong>Prototype data.</strong>
      <ul>
        {prototypeDataStatements.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>
    </aside>
  );
}
