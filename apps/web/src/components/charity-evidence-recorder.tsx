"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { publicSetting } from "@/lib/public-runtime-config";
import { supportedChain } from "@/lib/wagmi";
import {
  configuredAdminSafe,
  reviewSafeSubmission,
} from "@/lib/admin-safe-client";
import { type SafeSubmission } from "@/lib/admin-safe";
import { currentOperation } from "@/lib/current-operation";
import { isDaoWalletRejection } from "@/lib/dao-action-state";
import { setupRecoverySession } from "@/lib/setup-recovery";
import {
  CharityEvidenceFinalError,
  charityEvidenceRead,
  prepareCharityEvidenceForView,
  readCharityEvidenceOutcome,
} from "@/lib/charity-evidence-recovery";
import { operatorErrorText } from "@/lib/operator-error";
import {
  charityEvidenceCall,
  charityEvidenceFlow,
  isCharityEvidenceRecord,
  verifyCharityEvidenceReceipt,
  verifyDirectCharityEvidenceTransaction,
  type CharityEvidenceAction,
  type CharityEvidenceRecord,
} from "@/lib/charity-evidence";
import { AdminSafeConsole } from "./admin-safe-console";

export function CharityEvidenceRecorder({ tokenId }: { tokenId: string }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  if (!/^[1-9][0-9]{0,77}$/.test(tokenId) || BigInt(tokenId) >= 2n ** 256n)
    return (
      <p>
        Charity evidence recording is unavailable: the series ID is invalid.
      </p>
    );
  const configured = publicSetting(
    "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  );
  if (
    !configured ||
    !isAddress(configured) ||
    configured.toLowerCase() === zeroAddress
  )
    return (
      <p>
        Charity evidence recording is unavailable: the editions contract is not
        configured.
      </p>
    );
  return (
    <ConnectedRecorder
      key={`${chainId}:${address}:${isConnected}:${configured}:${tokenId}`}
      target={configured}
      account={isConnected ? address : undefined}
      chainId={chainId}
      tokenId={tokenId}
    />
  );
}

function ConnectedRecorder({
  target,
  account,
  chainId,
  tokenId,
}: {
  target: Address;
  account?: Address;
  chainId: number;
  tokenId: string;
}) {
  const client = usePublicClient({ chainId: supportedChain.id });
  const { writeContractAsync } = useWriteContract();
  const [action, setAction] = useState<CharityEvidenceAction>("sellout");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [prepared, setPrepared] = useState<{
    record: CharityEvidenceRecord;
    submission: SafeSubmission;
  }>();
  const [message, setMessage] = useState(
    "No evidence has been recorded by this screen. Only independently reviewed evidence commitments belong here.",
  );
  const session = useMemo(
    () =>
      setupRecoverySession<CharityEvidenceRecord>(
        `charity-evidence:${chainId}:${target.toLowerCase()}:${account?.toLowerCase() ?? "disconnected"}:${tokenId}`,
        (value): value is CharityEvidenceRecord =>
          isCharityEvidenceRecord(value) &&
          value.chainId === chainId &&
          value.tokenId === tokenId &&
          value.target.toLowerCase() === target.toLowerCase() &&
          value.account.toLowerCase() === account?.toLowerCase(),
      ),
    [account, chainId, target, tokenId],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const view = useRef(currentOperation());
  useLayoutEffect(() => {
    session.restore(() => sessionStorage);
    view.current = currentOperation();
    const retire = () => view.current.retire();
    window.addEventListener("pagehide", retire);
    window.addEventListener("popstate", retire);
    return () => {
      retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("popstate", retire);
    };
  }, [session]);
  const ready = Boolean(
    snapshot.ready && account && client && chainId === supportedChain.id,
  );
  const writable =
    ready && !snapshot.busy && !snapshot.blocked && !snapshot.record?.pending;
  function edit() {
    view.current.retire();
    view.current = currentOperation();
    setPrepared(undefined);
    setAcknowledged(false);
  }
  async function finish(
    lease: number,
    record: CharityEvidenceRecord,
    hash: Hex,
    current: ReturnType<typeof currentOperation>,
    retainRepricedHash = true,
  ) {
    if (!client) throw new Error("The reviewed chain client is unavailable.");
    const result = await readCharityEvidenceOutcome(
      client,
      record,
      hash,
      () => current.assertCurrent(),
      (next) => {
        current.assertCurrent();
        if (retainRepricedHash) session.repriced(lease, next);
      },
    );
    current.assertCurrent();
    session.resolved(lease, { ...record, outcome: result.outcome });
    return result;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!writable || !client || !account || !acknowledged) return;
    const lease = session.begin();
    if (lease === undefined) return;
    const current = view.current;
    const record: CharityEvidenceRecord = {
      chainId: 560048,
      target,
      account,
      tokenId,
      action,
      evidenceHash: evidenceHash as Hex,
    };
    try {
      if (!isCharityEvidenceRecord(record))
        throw new Error(
          "Use a positive token ID and a nonzero bytes32 evidence hash.",
        );
      const result = await prepareCharityEvidenceForView(
        client,
        record,
        configuredAdminSafe(),
        () => current.assertCurrent(),
      );
      current.assertCurrent();
      if (result.safeSubmission) {
        setPrepared({ record, submission: result.safeSubmission });
        setMessage(
          "The exact zero-value evidence call is prepared for the configured recorder Safe. Each owner must review it independently; threshold and timelock still apply.",
        );
        return;
      }
      session.save(lease, record);
      current.assertCurrent();
      session.awaitWallet(lease, action);
      setMessage(
        "Confirm the exact evidence hash, series and zero-value call in your wallet. Gas is separate. A pending request is not a completed record.",
      );
      const hash = await writeContractAsync({
        ...charityEvidenceCall(record),
        account: record.account,
      });
      // Persist a late wallet hash before retiring a departed screen.
      session.broadcast(lease, hash);
      current.assertCurrent();
      const resultRecord = await finish(lease, record, hash, current);
      current.assertCurrent();
      setMessage(
        `${resultRecord.action === "sellout" ? "Sellout evidence" : "Physical donation acceptance evidence"} recorded for series ${resultRecord.tokenId}. Transaction: ${resultRecord.transactionHash}. Refresh edition facts to view the current chain record.`,
      );
    } catch (error) {
      if (isDaoWalletRejection(error)) session.rejected(lease);
      const saved = session.getSnapshot().record;
      if (
        error instanceof CharityEvidenceFinalError &&
        saved &&
        current.isCurrent()
      ) {
        current.assertCurrent();
        session.resolved(lease, { ...saved.data, outcome: error.outcome });
      }
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }
  async function reconcile() {
    if (!ready || !client) return;
    const lease = session.begin(true);
    if (lease === undefined) return;
    const current = view.current;
    const saved = session.getSnapshot().record;
    try {
      if (!saved?.pending)
        throw new Error(
          "No unresolved direct evidence call is stored for this series and wallet.",
        );
      const hash =
        saved.pending.hash ??
        (/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)
          ? (recoveryHash as Hex)
          : undefined);
      if (!hash)
        throw new Error(
          "Check the original wallet activity and supply its transaction hash. Do not submit again.",
        );
      await charityEvidenceRead(
        () => current.assertCurrent(),
        (active) =>
          verifyDirectCharityEvidenceTransaction(
            client,
            saved.data,
            hash,
            active,
          ),
      );
      current.assertCurrent();
      // A user-supplied candidate hash is not proof of the unanswered request's identity.
      // Only its matching successful canonical record resolves the logical one-time action.
      // Do not persist a failed candidate as the known original or unlock on its failure.
      const result = await finish(
        lease,
        saved.data,
        hash,
        current,
        Boolean(saved.pending.hash),
      );
      current.assertCurrent();
      setMessage(
        `The original evidence call for series ${result.tokenId} is reconciled. Transaction: ${result.transactionHash}. Refresh edition facts for current chain state.`,
      );
    } catch (error) {
      if (
        error instanceof CharityEvidenceFinalError &&
        saved?.pending?.hash &&
        current.isCurrent()
      ) {
        current.assertCurrent();
        session.resolved(lease, { ...saved.data, outcome: error.outcome });
      }
      if (current.isCurrent())
        session.fail(lease, new Error(operatorErrorText(error)));
    } finally {
      session.finish(lease);
    }
  }
  async function recoverSafe(hash: Hex, submission: SafeSubmission) {
    if (!client) throw new Error("The reviewed chain client is unavailable.");
    const current = view.current;
    // The existing Safe console verifies its exact proposal and execution, including another owner.
    const decoded = reviewSafeSubmission(
      charityEvidenceFlow(action),
      target,
      submission,
      BigInt(tokenId),
    );
    const record: CharityEvidenceRecord = {
      chainId: 560048,
      account: account!,
      target,
      tokenId,
      action,
      evidenceHash: decoded.namedArgs.evidenceHash as Hex,
    };
    const result = await charityEvidenceRead(
      () => current.assertCurrent(),
      async (active) => {
        const receipt = await client.getTransactionReceipt({ hash });
        active();
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
          throw Error(
            "The Safe evidence receipt hash does not match its original execution.",
          );
        return verifyCharityEvidenceReceipt(client, record, receipt, active);
      },
    );
    current.assertCurrent();
    setMessage(
      `The Safe evidence record for series ${result.tokenId} is reconciled with its exact event and canonical recorded hash. Transaction: ${result.transactionHash}. Refresh edition facts for current state.`,
    );
  }
  return (
    <section
      className="transaction-panel"
      data-no-translate
      aria-label="Charity evidence recording"
    >
      <h3>Record independently reviewed charity evidence</h3>
      <p>
        Series {tokenId} · Hoodi · target {target}. Only DONATION_RECORDER_ROLE
        holders, or independent owners of the configured role-holding Safe, can
        record evidence.
      </p>
      <p>
        A zero distribution balance is necessary for sellout recording and is
        not proof of sales. Reconcile the external primary-sale records
        independently first. Physical donation requires the already-recorded
        sellout and separate CCHS acceptance evidence.
      </p>
      <p>
        This records an evidence commitment. It does not sell an edition,
        transfer an artwork, issue a tax receipt or give NFT holders physical
        rights. Do not upload private originals, images or personal documents
        here.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={!writable}>
          <legend>Exact evidence call</legend>
          <label>
            Evidence action{" "}
            <select
              value={action}
              onChange={(event) => {
                edit();
                setAction(event.target.value as CharityEvidenceAction);
              }}
            >
              <option value="sellout">Record reconciled sellout</option>
              <option value="donation">
                Record CCHS physical donation acceptance
              </option>
            </select>
          </label>
          <label>
            Reviewed evidence hash (bytes32){" "}
            <input
              value={evidenceHash}
              onChange={(event) => {
                edit();
                setEvidenceHash(event.target.value);
              }}
              pattern="0x[0-9a-fA-F]{64}"
              maxLength={66}
              required
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              required
            />
            {action === "sellout"
              ? "I independently reconciled the external sale records and reviewed this exact evidence commitment. A transfer or zero balance alone is insufficient."
              : "I independently reviewed CCHS physical-donation acceptance evidence for this work, after its recorded sellout."}
          </label>
        </fieldset>
        <button type="submit" disabled={!writable || !acknowledged}>
          Review evidence record with wallet or Safe
        </button>
      </form>
      {!ready ? (
        <p>
          Connect the authorized wallet on Hoodi. Missing configuration,
          authority or chain state never enables a write.
        </p>
      ) : null}
      {snapshot.record?.pending ? (
        <div>
          <p>
            The original {snapshot.record.pending.step} request is unresolved.
            Navigation does not cancel it; another direct evidence write remains
            blocked.
          </p>
          {snapshot.record.pending.hash ? (
            <p>Original transaction: {snapshot.record.pending.hash}</p>
          ) : (
            <label>
              Original wallet transaction hash{" "}
              <input
                value={recoveryHash}
                onChange={(event) => setRecoveryHash(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            disabled={!ready || snapshot.busy}
            onClick={() => void reconcile()}
          >
            Check original evidence transaction
          </button>
        </div>
      ) : null}
      {snapshot.blocked ? (
        <p role="alert">
          Recovery storage needs inspection. No new direct evidence write is
          enabled.
        </p>
      ) : null}
      <p role="status">{message}</p>
      {snapshot.error ? <p role="alert">{snapshot.error}</p> : null}
      <AdminSafeConsole
        kind={charityEvidenceFlow(action)}
        target={target}
        expectedTokenId={
          /^[1-9][0-9]{0,77}$/.test(tokenId) ? BigInt(tokenId) : undefined
        }
        prepared={prepared?.submission}
        onExecuted={recoverSafe}
      />
    </section>
  );
}
