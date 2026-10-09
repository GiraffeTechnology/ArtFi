"use client";

import { operatorErrorText } from "@/lib/operator-error";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { keccak256, type Address, type Hex } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { artFiAdminSafeAbi } from "@/lib/contracts";
import {
  proposalStage,
  secondsUntilExecutable,
  type SafeSubmission,
} from "@/lib/admin-safe";
import {
  assertSameSafeSubmission,
  configuredAdminSafe,
  existingSafeSubmission,
  isSafeRecord,
  loadSafeProposal,
  operatorCallRoute,
  recordSubmission,
  recoverSafeExecution,
  reviewSafeSubmission,
  safeFlowSpec,
  sameSafeValue,
  submittedProposal,
  verifySafeTransaction,
  type SafeFlow,
  type SafeLiveState,
  type SafeRecord,
} from "@/lib/admin-safe-client";
import { currentOperation } from "@/lib/current-operation";
import { isDaoWalletRejection } from "@/lib/dao-action-state";
import {
  confirmMarketReceipt,
  MarketReceiptFinalError,
} from "@/lib/market-transaction";
import { setupRecoverySession } from "@/lib/setup-recovery";
import { supportedChain } from "@/lib/wagmi";

type Props = {
  kind: SafeFlow;
  target?: Address;
  prepared?: SafeSubmission;
  authenticated?: boolean;
  onExecuted?: (hash: Hex, submission: SafeSubmission) => Promise<void>;
};

/** One bounded console for the existing three privileged creation calls. No arbitrary calls or ETH. */
export function AdminSafeConsole(props: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  let safe: Address | undefined;
  try {
    safe = configuredAdminSafe();
  } catch (error) {
    return (
      <p role="alert">
        {error instanceof Error
          ? error.message
          : "Safe configuration is unavailable."}
      </p>
    );
  }
  if (!safe) return null;
  return (
    <ConnectedSafeConsole
      key={`${chainId}:${address}:${safe}:${props.kind}:${props.target}`}
      {...props}
      safe={safe}
      account={address}
      chainId={chainId}
    />
  );
}

function ConnectedSafeConsole({
  kind,
  target,
  prepared,
  authenticated = false,
  onExecuted,
  safe,
  account,
  chainId,
}: Props & { safe: Address; account?: Address; chainId: number }) {
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const session = useMemo(
    () =>
      setupRecoverySession<SafeRecord>(
        `safe:${chainId}:${safe.toLowerCase()}:${account?.toLowerCase() ?? "disconnected"}:${kind}`,
        (value): value is SafeRecord =>
          isSafeRecord(value) &&
          value.chainId === chainId &&
          sameSafeValue(value.safe, safe) &&
          Boolean(account && sameSafeValue(value.wallet, account)) &&
          value.kind === kind,
      ),
    [account, chainId, kind, safe],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const [live, setLive] = useState<SafeLiveState>();
  const [proposalInput, setProposalInput] = useState("");
  const [recoveryHash, setRecoveryHash] = useState("");
  const [message, setMessage] = useState(
    "Review an unsigned creation call here, or load a proposal ID from another owner.",
  );
  const [reviewedKey, setReviewedKey] = useState<string>();
  const [loadedWithPreparedId, setLoadedWithPreparedId] = useState<Hex>();
  const view = useRef(currentOperation());
  const data = snapshot.record?.data;
  const pending = snapshot.record?.pending;
  const newPrepared = Boolean(
    prepared &&
    data?.transactionId &&
    !pending &&
    loadedWithPreparedId !== prepared.requestId &&
    !sameSafeValue(prepared.requestId, data.submission.requestId),
  );
  const submission = newPrepared
    ? prepared
    : data?.transactionId || pending
      ? data && recordSubmission(data)
      : prepared;
  const id =
    !newPrepared && data?.transactionId
      ? BigInt(data.transactionId)
      : undefined;
  const reviewIdentity = submission
    ? `${submission.target}:${submission.requestId}:${submission.data}:${id ?? "new"}`
    : "";
  const reviewed = Boolean(reviewIdentity && reviewedKey === reviewIdentity);
  const stage = newPrepared
    ? "unknown"
    : proposalStage(live?.transaction, live?.threshold ?? 0n, live?.now ?? 0n);
  const ready = Boolean(
    account &&
    client &&
    target &&
    chainId === supportedChain.id &&
    (kind === "charity" || authenticated),
  );
  const writable = ready && !snapshot.busy && !snapshot.blocked && !pending;

  useLayoutEffect(() => {
    session.restore(() => sessionStorage);
    const token = currentOperation();
    view.current = token;
    const retire = () => {
      view.current.retire();
      view.current = currentOperation();
    };
    window.addEventListener("pagehide", retire);
    window.addEventListener("popstate", retire);
    return () => {
      view.current.retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("popstate", retire);
    };
  }, [session]);
  useLayoutEffect(() => {
    view.current.retire();
    view.current = currentOperation();
  }, [prepared?.data, prepared?.requestId]);
  useEffect(() => {
    let cancelled = false;
    if (account && client && chainId === supportedChain.id) {
      void loadSafeProposal(client, safe, account, id)
        .then((state) => {
          if (!cancelled) setLive(state);
        })
        .catch(() => {
          /* Explicit refresh exposes any read failure; no writes are enabled by missing state. */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [account, chainId, client, id, safe]);

  async function authorize() {
    if (
      !client ||
      !account ||
      !target ||
      chainId !== supportedChain.id ||
      !view.current.isCurrent()
    )
      throw new Error(
        "Connect the reviewed chain and wallet on the current screen.",
      );
    if (kind !== "charity") {
      const response = await fetch("/api/operator/auth/session", {
        cache: "no-store",
      });
      const auth = (await response.json()) as {
        authenticated?: boolean;
        address?: string;
      };
      if (
        !response.ok ||
        !auth.authenticated ||
        !auth.address ||
        !sameSafeValue(auth.address, account)
      )
        throw new Error(
          "Verify this operator wallet again before a safe action.",
        );
    }
    if ((await client.getChainId()) !== chainId)
      throw new Error(
        "The connected RPC chain does not match this deployment.",
      );
    const route = await operatorCallRoute(client, kind, target, account, safe);
    if (!sameSafeValue(route, safe))
      throw new Error(
        "The configured safe does not hold this target's required role.",
      );
    view.current.assertCurrent();
  }

  async function refreshed(
    record: SafeRecord,
    current: ReturnType<typeof currentOperation>,
  ) {
    if (!client || !account || !target)
      throw new Error("Safe reads are unavailable.");
    const state = await loadSafeProposal(
      client,
      safe,
      account,
      record.transactionId ? BigInt(record.transactionId) : undefined,
    );
    current.assertCurrent();
    if (state.transaction) {
      reviewSafeSubmission(kind, target, state.transaction);
      assertSameSafeSubmission(recordSubmission(record), state.transaction);
    }
    setLive(state);
    return state;
  }

  async function finishPending(
    lease: number,
    record: SafeRecord,
    hash: Hex,
    action: string,
    current: ReturnType<typeof currentOperation>,
  ) {
    if (!client) throw new Error("Safe receipt access is unavailable.");
    await verifySafeTransaction(client, hash, record, action);
    const receipt = await confirmMarketReceipt(client, hash, (replacement) =>
      session.repriced(lease, replacement),
    );
    // Repriced/replacement hashes must still be exactly the recorded call.
    await verifySafeTransaction(
      client,
      receipt.transactionHash,
      record,
      action,
    );
    let next = record;
    if (action === "submit") {
      const transactionId = submittedProposal(
        receipt,
        safe,
        record.wallet,
        recordSubmission(record),
      );
      if (transactionId === undefined)
        throw new Error(
          "The exact proposal event is missing. Keep the recovery record and inspect the original transaction.",
        );
      next = { ...record, transactionId: transactionId.toString() };
    }
    if (action === "execute")
      next = { ...next, executionHash: receipt.transactionHash };
    // A late wallet response is journaled before any departed screen is retired.
    session.resolved(lease, next);
    current.assertCurrent();
    const state = await refreshed(next, current);
    if (action === "execute" && !state.transaction?.executed)
      throw new Error("Execution is not confirmed in safe state.");
    setMessage(
      action === "submit"
        ? `Proposal ${next.transactionId} is submitted and has this owner's first confirmation. Share the safe address and proposal ID with the other owners.`
        : action === "execute"
          ? "The safe execution is confirmed. Continue below to recover the creation result."
          : action === "revoke"
            ? "Your confirmation was revoked. The on-chain count and timelock have been refreshed."
            : "Your independent owner confirmation is confirmed on chain.",
    );
  }

  async function act(action: "submit" | "confirm" | "revoke" | "execute") {
    if (!writable || !client || !account || !target || !submission) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const current = view.current;
    let record = data;
    try {
      await authorize();
      current.assertCurrent();
      reviewSafeSubmission(kind, target, submission);
      if (action !== "revoke" && !reviewed)
        throw new Error(
          "Review the exact target and calldata before this wallet action.",
        );
      if (action === "submit") {
        const block = await client.getBlockNumber();
        current.assertCurrent();
        const { value: _zero, ...publicCall } = submission;
        void _zero;
        record = {
          chainId,
          wallet: account,
          safe,
          kind,
          submission: publicCall,
          startBlock: block.toString(),
          previousIds: [
            ...new Set([
              ...(data?.previousIds ?? []),
              ...(data?.transactionId ? [data.transactionId] : []),
            ]),
          ].slice(-32),
        };
        session.save(lease, record);
      }
      if (!record) throw new Error("Prepare or load a proposal first.");
      if (action !== "submit") {
        const state = await refreshed(record, current);
        if (!state.owner || !state.transaction || state.transaction.executed)
          throw new Error("This proposal is not writable by this owner.");
        if (action === "confirm" && state.confirmed)
          throw new Error(
            "This owner has already confirmed. Another owner must confirm independently.",
          );
        if (action === "revoke" && !state.confirmed)
          throw new Error("This owner has no confirmation to revoke.");
        if (
          action === "execute" &&
          proposalStage(state.transaction, state.threshold, state.now) !==
            "executable"
        )
          throw new Error(
            "The on-chain threshold and timelock are not yet satisfied.",
          );
      }
      const call =
        action === "submit"
          ? {
              address: safe,
              abi: artFiAdminSafeAbi,
              account,
              chainId,
              functionName: "submit" as const,
              args: [
                submission.requestId,
                submission.target,
                0n,
                submission.data,
              ] as const,
            }
          : {
              address: safe,
              abi: artFiAdminSafeAbi,
              account,
              chainId,
              functionName: action,
              args: [BigInt(record.transactionId!)] as const,
            };
      if (call.functionName === "submit") {
        const simulation = await client.simulateContract(call);
        current.assertCurrent();
        if (
          await existingSafeSubmission(
            client,
            safe,
            submission,
            simulation.result,
          )
        ) {
          current.assertCurrent();
          const recovered = {
            ...record,
            transactionId: simulation.result.toString(),
          };
          session.resolved(lease, recovered);
          await refreshed(recovered, current);
          setMessage(
            "This exact proposal already exists. Its chain state was recovered without another wallet transaction.",
          );
          return;
        }
      } else await client.simulateContract(call);
      current.assertCurrent();
      session.awaitWallet(lease, action);
      setMessage(
        `Confirm the safe ${action} action in your wallet. No ETH value is attached; network gas is separate.`,
      );
      const hash =
        call.functionName === "submit"
          ? await writeContractAsync(call)
          : await writeContractAsync(call);
      session.broadcast(lease, hash);
      current.assertCurrent();
      await finishPending(lease, record, hash, action, current);
    } catch (error) {
      if (isDaoWalletRejection(error)) session.rejected(lease);
      if (error instanceof MarketReceiptFinalError && record)
        session.resolved(lease, record);
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function check() {
    if (!client || !account || !target || chainId !== supportedChain.id) return;
    const lease = session.begin(true);
    if (lease === undefined) return;
    const current = view.current;
    try {
      const record = session.getSnapshot().record?.data;
      const original = session.getSnapshot().record?.pending;
      if (original && record) {
        const hash =
          original.hash ??
          (/^0x[\da-fA-F]{64}$/.test(recoveryHash)
            ? (recoveryHash as Hex)
            : undefined);
        if (!hash)
          throw new Error(
            "Copy the original transaction hash from your wallet to check it. An unanswered wallet request remains blocked.",
          );
        await verifySafeTransaction(client, hash, record, original.step);
        current.assertCurrent();
        if (!original.hash) session.broadcast(lease, hash);
        await finishPending(lease, record, hash, original.step, current);
      } else if (record?.transactionId) {
        await refreshed(record, current);
        setMessage(
          "Proposal status refreshed from chain time. Each write rechecks the current owner, target role and proposal.",
        );
      } else {
        const state = await loadSafeProposal(client, safe, account);
        current.assertCurrent();
        setLive(state);
        setMessage(
          "Safe owners, threshold and delay refreshed from the configured chain.",
        );
      }
    } catch (error) {
      const record = session.getSnapshot().record?.data;
      if (error instanceof MarketReceiptFinalError && record)
        session.resolved(lease, record);
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function load() {
    if (
      !writable ||
      !client ||
      !account ||
      !target ||
      !/^[1-9][0-9]{0,77}$/.test(proposalInput)
    )
      return;
    const lease = session.begin();
    if (lease === undefined) return;
    const current = view.current;
    try {
      const state = await loadSafeProposal(
        client,
        safe,
        account,
        BigInt(proposalInput),
      );
      current.assertCurrent();
      if (!state.transaction) throw new Error("The proposal does not exist.");
      reviewSafeSubmission(kind, target, state.transaction);
      const {
        requestId,
        target: proposalTarget,
        data: calldata,
      } = state.transaction;
      session.save(lease, {
        chainId,
        wallet: account,
        safe,
        kind,
        transactionId: proposalInput,
        startBlock: "0",
        previousIds: [
          ...new Set([
            ...(data?.previousIds ?? []),
            ...(data?.transactionId ? [data.transactionId] : []),
          ]),
        ].slice(-32),
        submission: { requestId, target: proposalTarget, data: calldata },
      });
      setLive(state);
      setLoadedWithPreparedId(prepared?.requestId);
      setReviewedKey(undefined);
      setMessage(
        "Loaded from the configured safe. Review the entire call independently before confirming.",
      );
    } catch (error) {
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function recoverExecutionHash() {
    if (
      !data ||
      !client ||
      !writable ||
      !/^0x[\da-fA-F]{64}$/.test(recoveryHash)
    )
      return;
    const lease = session.begin();
    if (lease === undefined) return;
    const current = view.current;
    try {
      const state = await refreshed(data, current);
      if (!state.transaction?.executed)
        throw new Error("This proposal is not executed on chain.");
      const executionHash = await recoverSafeExecution(
        client,
        recoveryHash as Hex,
        data,
      );
      current.assertCurrent();
      session.save(lease, { ...data, executionHash });
      setMessage(
        "The execution receipt matches this proposal, including execution by another owner. Recover the creation result below.",
      );
    } catch (error) {
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  async function continueCreation() {
    if (!data?.executionHash || !onExecuted || !writable) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const current = view.current;
    try {
      const state = await refreshed(data, current);
      if (!state.transaction?.executed)
        throw new Error("The safe has not executed this proposal.");
      await onExecuted(data.executionHash, recordSubmission(data));
      current.assertCurrent();
      setMessage(
        "The creation result was handed back to this section's existing confirmation flow.",
      );
    } catch (error) {
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }

  let callReview: ReturnType<typeof reviewSafeSubmission> | undefined;
  let reviewError = "";
  if (target && submission) {
    try {
      callReview = reviewSafeSubmission(kind, target, submission);
    } catch (error) {
      reviewError =
        error instanceof Error ? error.message : "Call review failed.";
    }
  }
  const display = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
      2,
    );
  return (
    <section
      className="transaction-panel admin-safe-console"
      data-no-translate
      aria-label={`${safeFlowSpec[kind].name} multisignature administration`}
    >
      <h3>Multisignature administration</h3>
      <p>
        Configured safe: {safe}. Chain: {chainId}.
      </p>
      <p>
        Only this section&apos;s existing zero-value creation call is available.
        Submission confirms for its proposing owner; every other owner confirms
        separately.
      </p>
      <p>
        Threshold: {live?.threshold.toString() ?? "unavailable"} of{" "}
        {live?.owners.length ?? "?"}. Timelock:{" "}
        {live?.delay.toString() ?? "unavailable"} seconds after reaching the
        threshold.
      </p>
      {live ? (
        <details>
          <summary>On-chain owners</summary>
          <ul>
            {live.owners.map((owner) => (
              <li key={owner}>{owner}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {!ready ? (
        <p role="note">
          Connect the supported wallet network and verify the operator session
          where required. The deployment target must be available.
        </p>
      ) : null}
      {live && !live.owner ? (
        <p role="note">This wallet is not an owner of the configured safe.</p>
      ) : null}
      <label>
        Proposal ID from another owner{" "}
        <input
          value={proposalInput}
          onChange={(event) => setProposalInput(event.target.value)}
          inputMode="numeric"
          pattern="[1-9][0-9]*"
        />
      </label>
      <button
        type="button"
        disabled={!writable || !proposalInput}
        onClick={() => void load()}
      >
        Load safe proposal
      </button>
      <button
        type="button"
        disabled={
          snapshot.busy ||
          !client ||
          !account ||
          !target ||
          chainId !== supportedChain.id
        }
        onClick={() => void check()}
      >
        Refresh safe status
      </button>
      {!newPrepared &&
      prepared &&
      data?.transactionId &&
      !sameSafeValue(prepared.requestId, data.submission.requestId) ? (
        <button
          type="button"
          disabled={!writable}
          onClick={() => setLoadedWithPreparedId(undefined)}
        >
          Review newly prepared call
        </button>
      ) : null}
      {newPrepared && data?.transactionId ? (
        <p>
          Proposal {data.transactionId} remains on chain with its original call.
          This new exact call requires a separate proposal and fresh
          confirmations. Revoke old confirmations separately if appropriate.
        </p>
      ) : null}
      {data?.previousIds?.length ? (
        <p>
          Earlier proposal IDs for this browser session:{" "}
          {data.previousIds.join(", ")}. Load an ID above to inspect its current
          chain state.
        </p>
      ) : null}
      {id !== undefined ? (
        <p>
          Proposal {id.toString()}: {stage.replaceAll("-", " ")}. Confirmations:{" "}
          {live?.transaction?.confirmations ?? "unavailable"}. Your
          confirmation: {live?.confirmed ? "yes" : "no"}.
        </p>
      ) : null}
      {stage === "awaiting-timelock" && live ? (
        <p>
          {secondsUntilExecutable(live.transaction, live.now).toString()}{" "}
          seconds remaining at the last chain observation. Refresh to check
          readiness.
        </p>
      ) : null}
      {submission && callReview ? (
        <>
          <h4>Unsigned exact call review</h4>
          <p>Target: {submission.target}</p>
          <p>Request ID: {submission.requestId}</p>
          <p>
            Method: {callReview.functionName}. ETH value: 0. Calldata hash:{" "}
            {keccak256(submission.data)}
          </p>
          <label>
            Decoded arguments{" "}
            <textarea readOnly value={display(callReview.namedArgs)} rows={8} />
          </label>
          <label>
            Exact calldata{" "}
            <textarea readOnly value={submission.data} rows={4} />
          </label>
          <label className="admin-safe-review-check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) =>
                setReviewedKey(
                  event.target.checked ? reviewIdentity : undefined,
                )
              }
            />
            I independently reviewed this exact target, arguments and zero-value
            call.
          </label>
          {id === undefined || newPrepared ? (
            <button
              type="button"
              disabled={!writable || !live?.owner || !reviewed}
              onClick={() => void act("submit")}
            >
              Submit safe proposal
            </button>
          ) : null}
        </>
      ) : null}
      {reviewError ? <p role="alert">{reviewError}</p> : null}
      {id !== undefined && stage !== "executed" ? (
        <>
          <button
            type="button"
            disabled={
              !writable ||
              !live?.owner ||
              live.confirmed ||
              !reviewed ||
              !callReview
            }
            onClick={() => void act("confirm")}
          >
            Confirm as this owner
          </button>
          <button
            type="button"
            disabled={!writable || !live?.owner || !live.confirmed}
            onClick={() => void act("revoke")}
          >
            Revoke my confirmation
          </button>
          <button
            type="button"
            disabled={
              !writable ||
              !live?.owner ||
              stage !== "executable" ||
              !reviewed ||
              !callReview
            }
            onClick={() => void act("execute")}
          >
            Execute confirmed proposal
          </button>
        </>
      ) : null}
      {pending ? (
        <div>
          <p>
            The {pending.step} wallet request is unresolved. Refreshing or
            navigating away does not cancel it.
          </p>
          {pending.hash ? (
            <p>Transaction: {pending.hash}</p>
          ) : (
            <label>
              Original wallet transaction hash{" "}
              <input
                value={recoveryHash}
                onChange={(event) => setRecoveryHash(event.target.value)}
                placeholder="0x…"
              />
            </label>
          )}
        </div>
      ) : null}
      {stage === "executed" && data?.executionHash && onExecuted ? (
        <button
          type="button"
          disabled={!writable}
          onClick={() => void continueCreation()}
        >
          Recover creation result
        </button>
      ) : null}
      {stage === "executed" && !data?.executionHash ? (
        <div>
          <label>
            Execution transaction hash (any owner)
            <input
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <button
            type="button"
            disabled={!writable || !recoveryHash}
            onClick={() => void recoverExecutionHash()}
          >
            Check execution receipt
          </button>
        </div>
      ) : null}
      <p role="status">{message}</p>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
    </section>
  );
}
