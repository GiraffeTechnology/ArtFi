"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useUserSession } from "@/components/user-session-provider";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import {
  agentRequest,
  validAgentRuntimeStatus,
  validAgentOperation,
  agentMode,
  type AgentRuntimeStatus,
  type AgentOperation,
  type AgentHistory,
  type AgentWorkflow,
  validAgentWorkflow,
  ownerConfirmedMarkets,
  ownerConfirmedMarket,
} from "@/lib/agent-runtime-client";
import type { UserSession } from "@/lib/user-session-client-state";
import styles from "./administration.module.css";

export function AgentRuntimeConsole() {
  const auth = useUserSession(),
    wallet = useAccount();
  const key = portfolioSessionKey(auth, wallet);
  if (!key || !auth.session)
    return (
      <section className={styles.panel}>
        <h2>Your agent operations</h2>
        <p>
          Sign in with your wallet to read your intents and recovery history.
          Connecting a wallet alone is not a session.
        </p>
      </section>
    );
  return <PrivateAgentConsole key={key} session={auth.session} />;
}
function PrivateAgentConsole({ session }: { session: UserSession }) {
  const [runtime, setRuntime] = useState<AgentRuntimeStatus>();
  const [operation, setOperation] = useState<AgentOperation>();
  const [workflow, setWorkflow] = useState<AgentWorkflow>();
  const [operationKind, setOperationKind] = useState("actions");
  const [history, setHistory] = useState<AgentHistory>();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [revocationHash, setRevocationHash] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true),
    flight = useRef(false),
    generation = useRef(0);
  const requests = useRef<AbortController[]>([]);
  useEffect(() => {
    live.current = true;
    const activeRequests = requests.current;
    return () => {
      live.current = false;
      activeRequests.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void agentRequest("status", session, { signal: controller.signal })
      .then((value) => {
        if (!validAgentRuntimeStatus(value))
          throw Error("Agent runtime returned an invalid capability response.");
        if (active) {
          setRuntime(value);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setRuntime(undefined);
          setError(
            "Agent runtime is unavailable. Saved operations and execution are not confirmed.",
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, revision]);
  async function load(operationId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
      throw Error("Enter a valid operation ID.");
    const controller = new AbortController();
    requests.current.push(controller);
    const current = ++generation.current;
    const result = await agentRequest(
      `${operationKind}/${operationId}`,
      session,
      { signal: controller.signal },
    );
    if (
      !(operationKind === "actions"
        ? validAgentWorkflow(result, operationId, session)
        : validAgentOperation(result, operationId, session))
    )
      throw Error("The saved operation could not be verified.");
    const events = (await agentRequest(
      `${operationKind}/${operationId}/history`,
      session,
      { signal: controller.signal },
    )) as AgentHistory;
    if (
      events?.id !== operationId ||
      events.mode !==
        (operationKind === "actions"
          ? (result as AgentWorkflow).mode
          : agentMode) ||
      !Array.isArray(events.events) ||
      events.events.length > 100
    )
      throw Error("The operation history could not be verified.");
    if (live.current && current === generation.current) {
      if (operationKind === "actions") {
        setWorkflow(result as AgentWorkflow);
        setOperation(undefined);
      } else {
        setOperation(result as AgentOperation);
        setWorkflow(undefined);
      }
      setHistory(events);
    }
  }
  async function action(work: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      if (live.current) {
        setOperation(undefined);
        setWorkflow(undefined);
        setHistory(undefined);
        setError(
          reason instanceof Error
            ? reason.message
            : "The operation is unavailable.",
        );
      }
    } finally {
      flight.current = false;
      if (live.current) setBusy(false);
    }
  }
  function lookup(event: FormEvent) {
    event.preventDefault();
    const selected = id.trim();
    setOperation(undefined);
    setWorkflow(undefined);
    setHistory(undefined);
    void action(() => load(selected));
  }
  return (
    <div
      className={styles.workspace}
      data-no-translate="true"
      data-translation-skip="true"
    >
      <section className={styles.warning}>
        <strong>
          {runtime?.mode === "BOUNDED_SIGNED_AUTHORITY"
            ? "Autonomous authority unavailable"
            : "TEST_ONLY · No real value"}
        </strong>
        <p>
          User authority, operational execution and constitutional governance
          remain separate. No user keys are held by this runtime. The current
          Wallet requires owner confirmation for each operation. Autonomous
          signing, broadcasting and nonce revocation are unavailable through
          this runtime.
        </p>
      </section>
      <section className={styles.panel}>
        <h2>Continue with owner confirmation</h2>
        <p>
          Use the existing ArtFi review and wallet-confirmation flow for a
          supported action. These paths do not provide NO-HIL execution and do
          not grant standing authority.
        </p>
        <ul>
          {ownerConfirmedMarkets.map((market) => (
            <li key={market.kind}>
              <Link href={market.href}>{market.label}</Link>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.panel}>
        <div className={styles.header}>
          <h2>Runtime capabilities</h2>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={() => refresh((value) => value + 1)}
          >
            Refresh runtime
          </button>
        </div>
        {!runtime ? (
          <p role="status">Runtime availability is unconfirmed.</p>
        ) : (
          <>
            <p role="status">
              {runtime.state} ·{" "}
              {runtime.adapterKind === "artfi-isolated-test-v1"
                ? "Isolated integration-test adapter"
                : "Execution dependency unavailable"}
            </p>
            <p className={styles.muted}>
              Observed {new Date(runtime.observedAt).toLocaleString()}.
              Production readiness: no.
            </p>
            <ul>
              {runtime.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <details>
              <summary>Action availability</summary>
              <ul>
                {runtime.actions.map((item) => (
                  <li key={item.action}>
                    {item.action}:{" "}
                    {item.available ? "TEST_ONLY adapter" : "Unavailable"}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>
      <section className={styles.panel}>
        <h2>Read an operation</h2>
        <p>
          Only records belonging to the signed-in wallet can be read. A
          submitted request is not settlement.
        </p>
        <form onSubmit={lookup} className={styles.form}>
          <label>
            Operation type
            <select
              value={operationKind}
              disabled={busy}
              onChange={(event) => {
                setOperationKind(event.target.value);
                setOperation(undefined);
                setWorkflow(undefined);
                setHistory(undefined);
              }}
            >
              <option value="actions">Native multi-action workflow</option>
              <option value="intents">Initial bounded BUY</option>
            </select>
          </label>
          <label>
            Operation ID
            <input
              value={id}
              onChange={(event) => {
                setId(event.target.value);
                setOperation(undefined);
                setWorkflow(undefined);
                setHistory(undefined);
                generation.current++;
              }}
              disabled={busy}
              autoComplete="off"
              maxLength={128}
            />
          </label>
          <button
            className="button"
            disabled={
              busy ||
              !(operationKind === "actions"
                ? runtime?.capabilities.queryActions
                : runtime?.capabilities.queryIntent)
            }
            type="submit"
          >
            {busy ? "Reading…" : "Read operation"}
          </button>
        </form>
        {error && (
          <p role="alert" className={styles.warning}>
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {workflow && (
          <article className={styles.record}>
            <h3>Workflow {workflow.id}</h3>
            <p>
              {workflow.action} · {workflow.marketKind} · {workflow.state}
            </p>
            <p className={styles.muted}>
              {workflow.mode === agentMode
                ? "Isolated app-side contract. "
                : "Configured app-side contract. "}
              No live signing or production execution is claimed.
            </p>
            {ownerConfirmedMarket(workflow.marketKind) && (
              <p>
                <Link href={ownerConfirmedMarket(workflow.marketKind)!.href}>
                  Continue in the existing owner-confirmed market
                </Link>
              </p>
            )}
            <dl className={styles.detail}>
              <dt>Asset</dt>
              <dd>
                {workflow.asset.contract} / {workflow.asset.tokenId}
              </dd>
              <dt>Execution limit</dt>
              <dd>{workflow.limits.maxExecutions}</dd>
              <dt>Open-order limit</dt>
              <dd>{workflow.limits.maxOpenOrders}</dd>
              <dt>Aggregate exposure limit</dt>
              <dd>{workflow.limits.maxAggregateExposure}</dd>
              <dt>Recovery attempts</dt>
              <dd>{workflow.recoveryAttempts}</dd>
            </dl>
            <ol>
              {workflow.steps.map((step) => (
                <li className={styles.detail} key={step.name}>
                  {step.name}: {step.state}
                  {step.evidence?.transactionHash
                    ? ` · ${step.evidence.transactionHash}`
                    : ""}
                </li>
              ))}
            </ol>
            {workflow.reason && <p role="status">{workflow.reason}</p>}
          </article>
        )}
        {operation && (
          <article className={styles.record}>
            <h3>Operation {operation.id}</h3>
            <dl className={styles.detail}>
              <dt>Asset</dt>
              <dd>
                {operation.asset.chainId} / {operation.asset.contract} /{" "}
                {operation.asset.tokenId}
              </dd>
              <dt>Execution</dt>
              <dd>{operation.execution.state}</dd>
              <dt>Observation</dt>
              <dd>
                {operation.fresh
                  ? "Current"
                  : "Stale or unavailable; saved state only"}
              </dd>
              <dt>Grounding</dt>
              <dd>{operation.grounding.state}</dd>
              <dt>Reconciliation</dt>
              <dd>{operation.reconciliation.state}</dd>
              <dt>Recovery</dt>
              <dd>{operation.recovery.state}</dd>
              <dt>Revocation</dt>
              <dd>{operation.revocation.state}</dd>
              <dt>Transaction</dt>
              <dd>{operation.execution.transactionHash || "Unknown"}</dd>
            </dl>
            {runtime?.capabilities.recordRevocation && (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const current = operation;
                  void action(async () => {
                    if (!/^0x[0-9a-fA-F]{64}$/.test(revocationHash))
                      throw Error(
                        "Enter a valid submitted revocation transaction hash.",
                      );
                    const result = (await agentRequest(
                      `intents/${current.id}/revocations`,
                      session,
                      { body: { transactionHash: revocationHash } },
                    )) as { id: string; state: string };
                    if (
                      result?.id !== current.id ||
                      !["PENDING", "CONFIRMED"].includes(result.state)
                    )
                      throw Error("Revocation evidence is unconfirmed.");
                    await load(current.id);
                    if (live.current)
                      setNotice(
                        result.state === "CONFIRMED"
                          ? "Revocation was verified as canonically confirmed."
                          : "Revocation is recorded as pending. It is not effective until confirmed.",
                      );
                  });
                }}
              >
                <h3>Record an already-submitted revocation</h3>
                <p>
                  This verifies a transaction already submitted through a
                  supported wallet. It does not sign or send a revocation.
                </p>
                <label>
                  Revocation transaction hash
                  <input
                    value={revocationHash}
                    onChange={(event) => setRevocationHash(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    maxLength={66}
                  />
                </label>
                <button className="button button-secondary" disabled={busy}>
                  Verify revocation receipt
                </button>
              </form>
            )}
          </article>
        )}
      </section>
      {history && (
        <section className={styles.panel}>
          <h2>Durable operation history</h2>
          {history.events.length ? (
            <ol>
              {history.events.map((event) => (
                <li key={event.id} className={styles.detail}>
                  {event.state} · {event.kind}
                  {event.reason ? ` · ${event.reason}` : ""} ·{" "}
                  {new Date(event.observedAt).toLocaleString()}
                </li>
              ))}
            </ol>
          ) : (
            <p>No events in this page.</p>
          )}
        </section>
      )}
    </div>
  );
}
