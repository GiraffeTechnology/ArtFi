import type { Metadata } from "next";

export const metadata: Metadata = { title: "DAO" };

const governanceFacts = [
  ["Proposal", "014", "Approve conservation reserve"],
  ["Participation", "68.4%", "Quorum met"],
  ["Timelock", "48h", "Execution remains reserved"],
] as const;

export default function DaoPage() {
  return (
    <main className="approved-page approved-page--dao page-shell">
      <div className="module-banner">
        <span>DAO / transparency mode</span>
        <strong>Execution interface reserved</strong>
      </div>
      <header className="approved-page__header">
        <p className="approved-eyebrow">Governance</p>
        <h1>Governance, made legible.</h1>
        <p>
          Proposal, quorum, timelock, treasury and role state are visible here.
          This interface does not submit votes or execute proposals.
        </p>
      </header>
      <section
        className="governance-grid"
        aria-label="Read-only governance state"
      >
        {governanceFacts.map(([label, value, detail]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <p>{detail}</p>
          </article>
        ))}
      </section>
      <section className="treasury-strip" aria-label="Treasury preview">
        <div>
          <span>Treasury</span>
          <strong>$1.84M</strong>
        </div>
        <p>
          Illustrative Sepolia fixture · no funds controlled by this interface
        </p>
      </section>
    </main>
  );
}
