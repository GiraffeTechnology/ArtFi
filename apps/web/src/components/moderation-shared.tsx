"use client";

import type { ModerationCase } from "@/lib/administration";
import styles from "./administration.module.css";

export function caseLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function ModerationCaseDetail({ record }: { record: ModerationCase }) {
  return (
    <div>
      <h3>{record.target}</h3>
      <p className={styles.muted}>
        Case {record.id} · Revision {record.revision} ·{" "}
        {caseLabel(record.status)}
      </p>
      <p>Category: {caseLabel(record.category)}</p>
      <h4>Report</h4>
      <p className={styles.detail}>{record.details}</p>
      {record.decision !== "none" && (
        <>
          <h4>Decision: {caseLabel(record.decision)}</h4>
          <p className={styles.detail}>{record.decisionReason}</p>
        </>
      )}
      {record.publicNotice && (
        <p className={styles.warning}>
          Public content notice: {record.publicNotice}
        </p>
      )}
      {record.appealStatus !== "none" && (
        <>
          <h4>Appeal: {caseLabel(record.appealStatus)}</h4>
          <p className={styles.detail}>{record.appealStatement}</p>
          {record.appealResponse && (
            <p className={styles.detail}>
              Appeal response: {record.appealResponse}
            </p>
          )}
        </>
      )}
      <p className={styles.muted}>
        Updated {new Date(record.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}

export function CaseList({
  records,
  selected,
  select,
}: {
  records: ModerationCase[];
  selected: string;
  select: (id: string) => void;
}) {
  return records.length ? (
    <ul className={styles.list}>
      {records.map((record) => (
        <li key={record.id}>
          <button
            type="button"
            aria-pressed={selected === record.id}
            onClick={() => select(record.id)}
          >
            <strong>{record.target}</strong>
            <span>
              {caseLabel(record.status)} · {caseLabel(record.category)}
            </span>
            <span className={styles.muted}>
              {new Date(record.createdAt).toLocaleDateString()} · Revision{" "}
              {record.revision}
            </span>
          </button>
        </li>
      ))}
    </ul>
  ) : (
    <p>No cases in this view.</p>
  );
}

export function CasePagination({
  page,
  more,
  busy,
  change,
}: {
  page: number;
  more: boolean;
  busy: boolean;
  change: (page: number) => void;
}) {
  return (
    <div className={styles.actions}>
      <button
        className="button button-secondary"
        disabled={busy || page === 1}
        onClick={() => change(page - 1)}
      >
        Previous
      </button>
      <span>Page {page}</span>
      <button
        className="button button-secondary"
        disabled={busy || !more}
        onClick={() => change(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
