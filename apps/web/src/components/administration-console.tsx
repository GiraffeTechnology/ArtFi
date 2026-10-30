"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useUserSession } from "@/components/user-session-provider";
import {
  administrationKey,
  administrationRequest,
  AdministrationRequestError,
  type AdministrationAudit,
  type AdministrationPage,
  type ModerationCase,
  type PlatformConfiguration,
} from "@/lib/administration";
import type { UserSession } from "@/lib/user-session-client-state";
import {
  CaseList,
  CasePagination,
  ModerationCaseDetail,
} from "./moderation-shared";
import styles from "./administration.module.css";

export function AdministrationConsole() {
  const auth = useUserSession();
  const wallet = useAccount();
  const { session } = auth;
  const sessionKey = portfolioSessionKey(auth, wallet);
  if (!sessionKey || !session)
    return (
      <section className={styles.panel}>
        <h2>Administrator sign-in</h2>
        <p>
          Use the wallet sign-in control above. Access requires a separately
          configured application moderation role.
        </p>
        <p>
          Connecting a wallet, holding tokens or having a registrar role does
          not grant console access.
        </p>
        <Link href="/support">Report content or review your own appeals</Link>
      </section>
    );
  return <AdministrationWorkspace key={sessionKey} session={session} />;
}

function AdministrationWorkspace({ session }: { session: UserSession }) {
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [cases, setCases] = useState<AdministrationPage<ModerationCase>>({
    data: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
  const [selectedId, select] = useState("");
  const [config, setConfig] = useState<PlatformConfiguration>();
  const [audit, setAudit] = useState<{
    data: AdministrationAudit[];
    nextCursor: string;
  }>({ data: [], nextCursor: "" });
  const keys = useRef(new Map<string, string>());
  const locked = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      await administrationRequest("admin/session", session, {
        signal: controller.signal,
      });
      const [records, settings, events] = await Promise.all([
        administrationRequest<AdministrationPage<ModerationCase>>(
          `admin/moderation/cases?page=${page}&status=${filter}`,
          session,
          { signal: controller.signal },
        ),
        administrationRequest<PlatformConfiguration>("admin/config", session, {
          signal: controller.signal,
        }),
        administrationRequest<{
          data: AdministrationAudit[];
          nextCursor: string;
        }>("admin/audit", session, { signal: controller.signal }),
      ]);
      if (!active) return;
      setAuthorized(true);
      setCases(records);
      setConfig(settings);
      setAudit(events);
      select((current) =>
        records.data.some((record) => record.id === current)
          ? current
          : records.data[0]?.id || "",
      );
    })()
      .catch((reason) => {
        if (active) {
          setAuthorized(false);
          setCases({ data: [], page, pageSize: 20, hasMore: false });
          setConfig(undefined);
          setAudit({ data: [], nextCursor: "" });
          setError(
            reason instanceof Error
              ? reason.message
              : "The console is unavailable.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, page, filter, revision]);

  async function mutate(
    path: string,
    body: unknown,
    method: "POST" | "PUT" = "POST",
  ) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await administrationRequest(path, session, {
        method,
        body,
        key: administrationKey(keys.current, path, body),
      });
      if (live.current) {
        setMessage("Saved with a durable audit record.");
        setLoading(true);
        refresh((value) => value + 1);
      }
      return true;
    } catch (reason) {
      if (
        live.current &&
        reason instanceof AdministrationRequestError &&
        [401, 403].includes(reason.status)
      ) {
        setAuthorized(false);
        setCases({ data: [], page: 1, pageSize: 20, hasMore: false });
        setConfig(undefined);
        setAudit({ data: [], nextCursor: "" });
      }
      if (live.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "No result was confirmed. Retry the same request.",
        );
      return false;
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function olderAudit() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await administrationRequest<{
        data: AdministrationAudit[];
        nextCursor: string;
      }>(`admin/audit?before=${audit.nextCursor}`, session);
      if (live.current)
        setAudit((current) => ({
          data: [...current.data, ...result.data],
          nextCursor: result.nextCursor,
        }));
    } catch (reason) {
      if (
        live.current &&
        reason instanceof AdministrationRequestError &&
        [401, 403].includes(reason.status)
      ) {
        setAuthorized(false);
        setCases({ data: [], page: 1, pageSize: 20, hasMore: false });
        setConfig(undefined);
        setAudit({ data: [], nextCursor: "" });
      }
      if (live.current) setError("Older audit records could not be loaded.");
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  const selected = cases.data.find((record) => record.id === selectedId);
  return (
    <div className={styles.workspace} data-no-translate data-translation-skip>
      <div className={styles.header}>
        <p>
          Signed in as <span data-no-translate>{session.address}</span>
        </p>
        <button
          className="button button-secondary"
          disabled={busy || loading}
          onClick={() => {
            setLoading(true);
            setError("");
            refresh((value) => value + 1);
          }}
        >
          Refresh console
        </button>
      </div>
      {loading && (
        <p role="status">Loading current permissions and durable records…</p>
      )}
      {error && (
        <p role="alert" className={styles.status}>
          {error}
        </p>
      )}
      {message && (
        <p role="status" className={styles.status}>
          {message}
        </p>
      )}
      {authorized && (
        <>
          <section className={styles.panel}>
            <h2>Content review queue</h2>
            <p>
              Review the reported reference and evidence. Published warnings
              apply to content only. Seller identity, balances and trading
              authority are unchanged.
            </p>
            <div className={styles.filters}>
              <label htmlFor="moderation-status">Status</label>
              <select
                id="moderation-status"
                value={filter}
                disabled={busy || loading}
                onChange={(event) => {
                  setLoading(true);
                  setError("");
                  setFilter(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">All cases</option>
                <option value="open">Open</option>
                <option value="reviewing">In review</option>
                <option value="appealed">Pending appeal</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>
            <div className={styles.columns}>
              <div>
                <CaseList
                  records={cases.data}
                  selected={selectedId}
                  select={select}
                />
                <CasePagination
                  page={page}
                  more={cases.hasMore}
                  busy={busy || loading}
                  change={(value) => {
                    setLoading(true);
                    setError("");
                    setPage(value);
                  }}
                />
              </div>
              <div>
                {selected ? (
                  <>
                    <ModerationCaseDetail record={selected} />
                    <p className={styles.muted}>
                      Reporter:{" "}
                      <span data-no-translate>{selected.reporter}</span> ·
                      Private to this case and moderation staff
                    </p>
                    <DecisionForm
                      key={`${selected.id}:${selected.revision}`}
                      record={selected}
                      disabled={busy || loading}
                      save={mutate}
                    />
                  </>
                ) : (
                  <p>
                    Select a case to inspect its report, decision and appeal.
                  </p>
                )}
              </div>
            </div>
          </section>
          {config && (
            <section className={styles.panel}>
              <h2>Platform service notice</h2>
              <p>
                This plain-text notice appears on every ArtFi page. All changes
                are revision-checked and audited.
              </p>
              <ConfigurationForm
                key={config.revision}
                config={config}
                disabled={busy || loading}
                save={mutate}
              />
            </section>
          )}
          <section className={styles.panel}>
            <h2>Durable audit history</h2>
            <p>
              Read-only records include the actor, previous revision and
              resulting snapshot. This console has no audit edit or delete
              action.
            </p>
            {!audit.data.length && (
              <p>No application moderation events have been recorded.</p>
            )}
            {audit.data.map((entry) => (
              <article className={styles.record} key={entry.id}>
                <strong>{entry.action}</strong>
                <p className={styles.muted}>
                  {new Date(entry.occurredAt).toLocaleString()} · Audit{" "}
                  {entry.id}
                </p>
                <p className={styles.detail}>
                  Actor: {entry.metadata.actor}
                  <br />
                  Record: {entry.metadata.resourceId}
                  <br />
                  Previous revision: {entry.metadata.previousRevision}
                </p>
                <details>
                  <summary>Read recorded snapshot</summary>
                  <pre>{JSON.stringify(entry.metadata.snapshot, null, 2)}</pre>
                </details>
              </article>
            ))}
            {audit.nextCursor && (
              <button
                className="button button-secondary"
                disabled={busy || loading}
                onClick={() => void olderAudit()}
              >
                Load older audit records
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

type Save = (
  path: string,
  body: unknown,
  method?: "POST" | "PUT",
) => Promise<boolean>;
function DecisionForm({
  record,
  disabled,
  save,
}: {
  record: ModerationCase;
  disabled: boolean;
  save: Save;
}) {
  const appealed = record.status === "appealed";
  const [action, setAction] = useState(appealed ? "reject_appeal" : "resolve");
  const [decision, setDecision] = useState("no_action");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  if (record.status === "resolved")
    return (
      <p>
        The case is resolved. Its reporter can submit one appeal of this
        decision.
      </p>
    );
  const needsDecision = action === "resolve" || action === "uphold_appeal";
  const publishes = needsDecision && decision === "content_warning";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (publishes && !confirmed) return;
    await save(`admin/moderation/cases/${record.id}/decisions`, {
      revision: record.revision,
      action,
      reason: reason.trim(),
      decision: needsDecision ? decision : "",
      publicNotice: publishes ? notice.trim() : "",
    });
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h4>{appealed ? "Decide appeal" : "Record review"}</h4>
      <label>
        Action
        <select
          value={action}
          disabled={disabled}
          onChange={(event) => {
            setAction(event.target.value);
            setConfirmed(false);
          }}
        >
          {appealed ? (
            <>
              <option value="reject_appeal">
                Reject appeal and retain decision
              </option>
              <option value="uphold_appeal">
                Uphold appeal and replace decision
              </option>
            </>
          ) : (
            <>
              <option value="resolve">Resolve report</option>
              {record.status === "open" && (
                <option value="start_review">Start review</option>
              )}
            </>
          )}
        </select>
      </label>
      {needsDecision && (
        <label>
          Content outcome
          <select
            value={decision}
            disabled={disabled}
            onChange={(event) => {
              setDecision(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="no_action">No content warning</option>
            <option value="content_warning">Publish content warning</option>
          </select>
        </label>
      )}
      <label>
        Explanation for the case record
        <textarea
          required
          minLength={10}
          maxLength={4000}
          value={reason}
          disabled={disabled}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {publishes && (
        <>
          <label>
            Public warning text
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={notice}
              disabled={disabled}
              onChange={(event) => {
                setNotice(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <p className={styles.warning}>
            The public notice will identify “{record.target}”. Do not publish
            private report details or personal information.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I reviewed the reference and warning for public disclosure.
          </label>
        </>
      )}
      <button
        className="button button-primary"
        disabled={
          disabled ||
          reason.trim().length < 10 ||
          (publishes && (!confirmed || notice.trim().length < 10))
        }
        type="submit"
      >
        Save moderation decision
      </button>
    </form>
  );
}

function ConfigurationForm({
  config,
  disabled,
  save,
}: {
  config: PlatformConfiguration;
  disabled: boolean;
  save: Save;
}) {
  const [enabled, setEnabled] = useState(config.noticeEnabled);
  const [text, setText] = useState(config.noticeText);
  const [reason, setReason] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await save(
      "admin/config",
      {
        revision: config.revision,
        noticeEnabled: enabled,
        noticeText: text.trim(),
        reason: reason.trim(),
      },
      "PUT",
    );
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <p className={styles.muted}>Current revision: {config.revision}</p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Publish service notice
      </label>
      <label>
        Notice text
        <textarea
          value={text}
          maxLength={500}
          minLength={enabled ? 10 : undefined}
          required={enabled}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label>
        Reason for this change
        <textarea
          value={reason}
          required
          minLength={10}
          maxLength={4000}
          disabled={disabled}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button
        className="button button-primary"
        type="submit"
        disabled={
          disabled ||
          reason.trim().length < 10 ||
          (enabled && text.trim().length < 10)
        }
      >
        Save service notice
      </button>
    </form>
  );
}
