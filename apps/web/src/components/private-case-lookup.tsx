"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ModerationCase } from "@/lib/administration";
import { createPrivateCaseLookup } from "@/lib/moderation-case-lookup";
import type { UserSession } from "@/lib/user-session-client-state";
import styles from "./administration.module.css";
export function PrivateCaseLookup({
  session,
  onOpen,
  onDenied,
  disabled,
}: {
  session: UserSession;
  onOpen: (value: ModerationCase | undefined) => void;
  onDenied: () => void;
  disabled: boolean;
}) {
  const [id, setId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const reader = useRef<ReturnType<typeof createPrivateCaseLookup> | undefined>(
    undefined,
  );
  useEffect(() => {
    const current = createPrivateCaseLookup(session, {
      record: onOpen,
      denied: onDenied,
      busy: setBusy,
      error: setError,
    });
    reader.current = current;
    return () => {
      current.retire();
      if (reader.current === current) reader.current = undefined;
    };
  }, [session, onOpen, onDenied]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!disabled && !busy) void reader.current?.open(id);
  }
  return (
    <form
      className={styles.form}
      aria-label="Open your private case by ID"
      onSubmit={submit}
    >
      <h3>Open a case by ID</h3>
      <p>
        Use the complete case ID from your report. This reads only a case
        available to your signed-in wallet, independently of the current list
        page.
      </p>
      <label>
        Private case ID
        <input
          value={id}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          data-no-translate
          disabled={disabled}
          onChange={(event) => {
            reader.current?.clear();
            setId(event.currentTarget.value);
          }}
        />
      </label>
      <div className={styles.actions}>
        <button
          type="submit"
          className="button button-secondary"
          disabled={disabled || busy || !/^[a-f0-9]{32}$/i.test(id.trim())}
        >
          {busy ? "Opening private case…" : "Open private case"}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          onClick={() => {
            reader.current?.clear();
            setId("");
          }}
        >
          Clear case lookup
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p className={styles.muted}>
        Opening a record submits no report or appeal and changes no decision.
        The original case revision and eligibility rules still govern any
        appeal.
      </p>
    </form>
  );
}
