"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import { useUserSession } from "@/components/user-session-provider";
import {
  administrationKey,
  administrationRequest,
  AdministrationRequestError,
  type AdministrationPage,
  type ModerationCase,
  type ModerationNotice,
} from "@/lib/administration";
import type { UserSession } from "@/lib/user-session-client-state";
import {
  CaseList,
  CasePagination,
  ModerationCaseDetail,
} from "./moderation-shared";
import styles from "./administration.module.css";

export function ModerationSupport() {
  const auth = useUserSession();
  const wallet = useAccount();
  const { session } = auth;
  const sessionKey = portfolioSessionKey(auth, wallet);
  return (
    <div className={styles.workspace}>
      <PublicModerationNotices />
      {sessionKey && session ? (
        <PrivateModerationSupport key={sessionKey} session={session} />
      ) : (
        <section className={styles.panel}>
          <h2>Your reports and appeals</h2>
          <p>
            Sign in with your wallet to submit a report or read your private
            cases. Connecting a wallet alone does not establish a session.
          </p>
        </section>
      )}
    </div>
  );
}

function PublicModerationNotices() {
  const [data, setData] = useState<AdministrationPage<ModerationNotice>>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void administrationRequest<AdministrationPage<ModerationNotice>>(
      `moderation/notices?page=${page}`,
      undefined,
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) {
          setData(undefined);
          setError("Public content notices are currently unavailable.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, revision]);
  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <h2>Public content notices</h2>
        <button
          className="button button-secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError("");
            refresh((value) => value + 1);
          }}
        >
          Refresh notices
        </button>
      </div>
      <p>
        These notices concern reviewed marketplace content. They do not freeze
        assets, cancel signed orders or decide property rights.
      </p>
      {loading && <p role="status">Loading notices…</p>}
      {error && <p role="status">{error}</p>}
      {data && (
        <>
          {data.data.length ? (
            data.data.map((notice) => (
              <article className={styles.warning} key={notice.id}>
                <h3>{notice.target}</h3>
                <p className={styles.detail}>{notice.notice}</p>
                <p className={styles.muted}>
                  Updated {new Date(notice.updatedAt).toLocaleString()}
                </p>
              </article>
            ))
          ) : (
            <p>No active content warnings in this view.</p>
          )}
          <CasePagination
            page={page}
            more={data.hasMore}
            busy={loading}
            change={(value) => {
              setLoading(true);
              setError("");
              setPage(value);
            }}
          />
        </>
      )}
    </section>
  );
}

function PrivateModerationSupport({ session }: { session: UserSession }) {
  const [data, setData] = useState<AdministrationPage<ModerationCase>>({
    data: [],
    page: 1,
    pageSize: 20,
    hasMore: false,
  });
  const [selectedId, select] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
    let active = true;
    const controller = new AbortController();
    void administrationRequest<AdministrationPage<ModerationCase>>(
      `user/moderation/cases?page=${page}`,
      session,
      { signal: controller.signal },
    )
      .then((result) => {
        if (active) {
          setBlocked(false);
          setData(result);
          select((current) =>
            result.data.some((record) => record.id === current)
              ? current
              : result.data[0]?.id || "",
          );
        }
      })
      .catch((reason) => {
        if (active) {
          if (
            reason instanceof AdministrationRequestError &&
            [401, 403].includes(reason.status)
          )
            setBlocked(true);
          setData({ data: [], page, pageSize: 20, hasMore: false });
          setError(
            reason instanceof Error
              ? reason.message
              : "Your private cases are unavailable.",
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
  }, [session, page, revision]);
  async function submit(path: string, body: unknown) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await administrationRequest<ModerationCase>(
        path,
        session,
        {
          method: "POST",
          body,
          key: administrationKey(keys.current, path, body),
        },
      );
      if (live.current) {
        select(result.id);
        setPage(1);
        setLoading(true);
        refresh((value) => value + 1);
        setMessage(
          "Your request was recorded. The decision and any appeal response will appear in your case.",
        );
      }
      return true;
    } catch (reason) {
      if (
        live.current &&
        reason instanceof AdministrationRequestError &&
        [401, 403].includes(reason.status)
      ) {
        setBlocked(true);
        setData({ data: [], page: 1, pageSize: 20, hasMore: false });
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
  const selected = data.data.find((record) => record.id === selectedId);
  if (blocked)
    return (
      <section className={styles.panel}>
        <p role="alert">
          Your private case session is no longer available. Sign in again with
          this wallet.
        </p>
        <button
          className="button button-secondary"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError("");
            refresh((value) => value + 1);
          }}
        >
          Recheck session
        </button>
      </section>
    );
  return (
    <div data-no-translate data-translation-skip>
      <section className={styles.panel}>
        <h2>Report marketplace content</h2>
        <p>
          Include the product section, chain, contract and token or order
          identifier where applicable. Explain the content concern. Do not
          include passwords, private keys or unnecessary personal information.
        </p>
        <ReportForm disabled={busy || loading} save={submit} />
      </section>
      <section className={styles.panel}>
        <div className={styles.header}>
          <h2>Your private cases</h2>
          <button
            className="button button-secondary"
            disabled={busy || loading}
            onClick={() => {
              setLoading(true);
              setError("");
              refresh((value) => value + 1);
            }}
          >
            Refresh cases
          </button>
        </div>
        {loading && <p role="status">Loading your cases…</p>}
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
        <div className={styles.columns}>
          <div>
            <CaseList
              records={data.data}
              selected={selectedId}
              select={select}
            />
            <CasePagination
              page={page}
              more={data.hasMore}
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
                {selected.status === "resolved" &&
                  selected.appealStatus === "none" && (
                    <AppealForm
                      key={`${selected.id}:${selected.revision}`}
                      record={selected}
                      disabled={busy || loading}
                      save={submit}
                    />
                  )}
              </>
            ) : (
              <p>
                Your report details and appeals are visible only to you and
                authorized moderation staff.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

type Save = (path: string, body: unknown) => Promise<boolean>;
function ReportForm({ disabled, save }: { disabled: boolean; save: Save }) {
  const [target, setTarget] = useState("");
  const [category, setCategory] = useState("misleading_metadata");
  const [details, setDetails] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await save("user/moderation/cases", {
        target: target.trim(),
        category,
        details: details.trim(),
      })
    ) {
      setTarget("");
      setDetails("");
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <label>
        Content reference
        <input
          required
          minLength={3}
          maxLength={256}
          value={target}
          disabled={disabled}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="Product section, chain, contract and token / order ID"
        />
      </label>
      <label>
        Category
        <select
          value={category}
          disabled={disabled}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="misleading_metadata">Misleading metadata</option>
          <option value="inappropriate_content">Inappropriate content</option>
          <option value="suspected_fraud">Suspected fraud</option>
          <option value="other">Other content concern</option>
        </select>
      </label>
      <label>
        Explanation and evidence references
        <textarea
          required
          minLength={10}
          maxLength={4000}
          value={details}
          disabled={disabled}
          onChange={(event) => setDetails(event.target.value)}
        />
      </label>
      <p className={styles.muted}>
        Report details are private. A moderator may publish a reviewed content
        reference and warning, without publishing your report or wallet
        identity.
      </p>
      <button
        className="button button-primary"
        type="submit"
        disabled={
          disabled || target.trim().length < 3 || details.trim().length < 10
        }
      >
        Submit private report
      </button>
    </form>
  );
}
function AppealForm({
  record,
  disabled,
  save,
}: {
  record: ModerationCase;
  disabled: boolean;
  save: Save;
}) {
  const [statement, setStatement] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await save(`user/moderation/cases/${record.id}/appeals`, {
      revision: record.revision,
      statement: statement.trim(),
    });
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h4>Appeal this decision</h4>
      <p>
        You can submit one appeal for this case. Include the evidence or
        explanation the moderator should reconsider. The existing outcome
        remains in effect while the appeal is reviewed.
      </p>
      <label>
        Private appeal statement
        <textarea
          required
          minLength={10}
          maxLength={4000}
          value={statement}
          disabled={disabled}
          onChange={(event) => setStatement(event.target.value)}
        />
      </label>
      <button
        className="button button-primary"
        type="submit"
        disabled={disabled || statement.trim().length < 10}
      >
        Submit appeal
      </button>
    </form>
  );
}
