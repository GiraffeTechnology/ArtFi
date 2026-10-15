"use client";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Hex } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { useUserSession } from "./user-session-provider";
import {
  assertTradingSession,
  userSessionController,
} from "@/lib/user-session-client";
import {
  daoActionSession,
  checkDaoTransaction,
  isDaoWalletRejection,
  type DaoTransaction,
} from "@/lib/dao-action-state";
import { daoGovernorAbi, daoVotingTokenAbi } from "@/lib/dao-contracts";
import {
  daoExecutionDeployment,
  readPublishedDaoExecution,
  assertPublishedDaoAction,
  publishedDaoReadDeadline,
  publishedProposalStates,
  publishedActionSummary,
  type PublishedDaoExecution,
  type DaoExecutionDeployment,
} from "@/lib/dao-published-execution";

type InputDeployment = Parameters<typeof daoExecutionDeployment>[0];
export function DaoPublishedExecution({
  deployment,
}: {
  deployment: InputDeployment;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { revision } = useUserSession();
  let configured: DaoExecutionDeployment | undefined;
  try {
    configured = daoExecutionDeployment(deployment);
  } catch {
    /* Missing bindings stay explicit. */
  }
  const context = [
    chainId,
    address?.toLowerCase(),
    isConnected,
    deployment.governorAddress?.toLowerCase(),
    deployment.tokenAddress?.toLowerCase(),
    deployment.actionRegistryAddress?.toLowerCase(),
    deployment.vaultAddress?.toLowerCase(),
  ].join(":");
  if (!configured)
    return (
      <section className="dao-panel">
        <h2>Published proposal execution unavailable</h2>
        <p>All four existing DAO deployment bindings are required.</p>
      </section>
    );
  return (
    <PublishedExecutionSession
      key={context + ":" + revision}
      context={context}
      deployment={configured}
    />
  );
}
function PublishedExecutionSession({
  context,
  deployment,
}: {
  context: string;
  deployment: DaoExecutionDeployment;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const client = usePublicClient();
  const { authenticated, revision } = useUserSession();
  const { writeContractAsync } = useWriteContract();
  const session = useMemo(() => daoActionSession(context), [context]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const [input, setInput] = useState("");
  const [snapshot, setSnapshot] = useState<PublishedDaoExecution>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const readGeneration = useRef(0);
  const readBusy = useRef(false);
  const correctChain = isConnected && chainId === 560048;
  const pending =
    state.busy ||
    state.awaitingWallet ||
    state.transaction?.phase === "pending" ||
    state.transaction?.phase === "unknown";
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      readGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (authenticated && correctChain)
      session.restore(
        () => window.sessionStorage,
        deployment.actionRegistryAddress,
      );
  }, [authenticated, correctChain, session, deployment.actionRegistryAddress]);
  function assertCurrent() {
    if (
      !active.current ||
      userSessionController.getSnapshot().revision !== revision
    )
      throw Error("The current wallet session changed.");
  }
  async function load() {
    if (!client || readBusy.current || pending) return;
    const generation = ++readGeneration.current;
    readBusy.current = true;
    setLoading(true);
    setSnapshot(undefined);
    setError("");
    try {
      const result = await publishedDaoReadDeadline(
        readPublishedDaoExecution(client, deployment, input as Hex),
      );
      if (active.current && generation === readGeneration.current)
        setSnapshot(result);
    } catch {
      if (active.current && generation === readGeneration.current)
        setError(
          "The original proposal transaction and DAO binding could not be verified. Check Hoodi and reload.",
        );
    } finally {
      readBusy.current = false;
      if (active.current && generation === readGeneration.current)
        setLoading(false);
    }
  }
  async function confirm(transaction: DaoTransaction, lease: number) {
    if (!client) throw Error("The chain reader is unavailable.");
    let expected = transaction.hash;
    await checkDaoTransaction({
      client,
      transaction,
      isCurrent: () => session.isCurrent(lease),
      update: (next) =>
        session.updateTransaction(
          lease,
          expected,
          next,
          () => window.sessionStorage,
        ),
      onHash: (hash) => {
        if (
          session.replaceHash(
            lease,
            expected,
            hash,
            () => window.sessionStorage,
          )
        )
          expected = hash;
      },
    });
  }
  async function act(mode: "queue" | "execute") {
    if (
      !client ||
      !address ||
      !snapshot ||
      !authenticated ||
      !correctChain ||
      loading ||
      pending
    )
      return;
    const reviewed = snapshot;
    const account = address;
    const lease = session.begin();
    if (lease === undefined) return;
    setError("");
    setSnapshot(undefined);
    try {
      await assertTradingSession(account, 560048);
      assertCurrent();
      const current = await publishedDaoReadDeadline(
        readPublishedDaoExecution(client, deployment, reviewed.transactionHash),
      );
      assertCurrent();
      if (
        current.proposal.proposalId !== reviewed.proposal.proposalId ||
        current.creationBlockHash !== reviewed.creationBlockHash
      )
        throw Error("The published proposal changed.");
      assertPublishedDaoAction(current, mode);
      const balance = await publishedDaoReadDeadline(
        client.readContract({
          address: deployment.tokenAddress,
          abi: daoVotingTokenAbi,
          functionName: "balanceOf",
          args: [account],
          blockNumber: current.blockNumber,
        }),
      );
      assertCurrent();
      if (typeof balance !== "bigint" || balance <= 0n)
        throw Error("Corresponding holder membership is required.");
      const proposal = current.proposal;
      const request = {
        address: deployment.governorAddress,
        abi: daoGovernorAbi,
        functionName: mode,
        args: [
          proposal.targets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash,
        ],
        account,
        chain: client.chain,
      } as const;
      await publishedDaoReadDeadline(client.simulateContract(request));
      await assertTradingSession(account, 560048);
      assertCurrent();
      if (
        !session.isCurrent(lease) ||
        !session.awaitWallet(lease, () => window.sessionStorage)
      )
        return;
      // A late wallet result must still reach the original durable session after navigation.
      const hash = await writeContractAsync({
        address: deployment.governorAddress,
        abi: daoGovernorAbi,
        functionName: mode,
        args: [
          proposal.targets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash,
        ],
        account,
        chainId: 560048,
      });
      const transaction: DaoTransaction = {
        hash,
        phase: "pending",
        success:
          mode === "queue"
            ? "Published proposal queued. Reload its current state."
            : "Published proposal execution confirmed. Reload its public result.",
      };
      if (
        session.broadcast(
          lease,
          transaction,
          undefined,
          () => window.sessionStorage,
        )
      )
        await confirm(transaction, lease);
    } catch (cause) {
      session.fail(
        lease,
        "The DAO operation stopped. Check its saved request and chain result before another wallet request.",
        isDaoWalletRejection(cause),
        () => window.sessionStorage,
      );
    } finally {
      session.finish(lease);
    }
  }
  async function reconcile() {
    if (!client || !state.transaction || !authenticated || !correctChain)
      return;
    const lease = session.begin(true);
    if (lease === undefined) return;
    try {
      await confirm(state.transaction, lease);
    } catch {
      session.fail(
        lease,
        "Transaction confirmation is unavailable; no operation was replayed.",
        false,
        () => window.sessionStorage,
      );
    } finally {
      session.finish(lease);
    }
  }
  return (
    <section
      className="dao-panel"
      aria-label="Published DAO proposal execution"
    >
      <h2>Load a published proposal</h2>
      <p>
        Use the original Hoodi proposal-creation transaction. Loading public
        terms does not authorize a wallet action. Only the configured
        single-action, zero-value DAO model is supported.
      </p>
      <label>
        Proposal creation transaction
        <input
          value={input}
          data-no-translate
          disabled={loading || pending}
          placeholder="0x…"
          onChange={(e) => {
            readGeneration.current++;
            setSnapshot(undefined);
            setError("");
            setInput(e.target.value);
          }}
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={!client || loading || pending}
        onClick={() => void load()}
      >
        {loading ? "Reading proposal…" : "Load published terms"}
      </button>
      {snapshot && (
        <article>
          <h3>Review exact on-chain terms</h3>
          <p data-no-translate>
            Proposal: {snapshot.proposal.proposalId.toString()}
          </p>
          <p>{snapshot.proposal.description}</p>
          <dl className="dao-metrics">
            <div>
              <dt>State</dt>
              <dd>{publishedProposalStates[snapshot.state]}</dd>
            </div>
            <div>
              <dt>Action class</dt>
              <dd>
                {
                  [
                    "",
                    "Market migration",
                    "Physical action",
                    "Forced-buyout initiation",
                  ][snapshot.kind]
                }
              </dd>
            </div>
            <div>
              <dt>Timelock ETA, chain seconds</dt>
              <dd>{snapshot.eta.toString()}</dd>
            </div>
            <div>
              <dt>Observation block</dt>
              <dd>{snapshot.blockNumber.toString()}</dd>
            </div>
          </dl>
          <h4 data-no-translate>
            {publishedActionSummary(snapshot.proposal).functionName}
          </h4>
          <pre className="charity-digest" data-no-translate>
            {publishedActionSummary(snapshot.proposal).arguments}
          </pre>
          <details>
            <summary>Exact execution and source</summary>
            <p className="charity-digest" data-no-translate>
              Governor: {deployment.governorAddress}
              <br />
              Action registry: {snapshot.proposal.targets[0]}
              <br />
              Value: 0<br />
              Calldata: {snapshot.proposal.calldatas[0]}
              <br />
              Description hash: {snapshot.proposal.descriptionHash}
              <br />
              Creation transaction: {snapshot.transactionHash}
              <br />
              Creation block: {snapshot.creationBlock.toString()} /{" "}
              {snapshot.creationBlockHash}
              <br />
              Observation block hash: {snapshot.blockHash}
            </p>
          </details>
          <p>
            The observation reserves nothing. State, canonical creation,
            membership and simulation are checked again before a wallet request.
            Queueing preserves the contract timelock. This interface adds no
            debit or buyout settlement function.
          </p>
          {!authenticated && (
            <p>
              Sign in with the corresponding holder wallet before any
              transaction.
            </p>
          )}
          {!correctChain && <p>Connect the corresponding wallet on Hoodi.</p>}
          <div className="dao-actions-row">
            <button
              type="button"
              disabled={
                !authenticated ||
                !correctChain ||
                pending ||
                loading ||
                snapshot.state !== 4
              }
              onClick={() => void act("queue")}
            >
              Queue reviewed proposal
            </button>
            <button
              type="button"
              disabled={
                !authenticated ||
                !correctChain ||
                pending ||
                loading ||
                snapshot.state !== 5 ||
                snapshot.eta === 0n ||
                snapshot.eta > snapshot.observedAt
              }
              onClick={() => void act("execute")}
            >
              Execute reviewed proposal
            </button>
          </div>
        </article>
      )}
      {error && <p role="alert">{error}</p>}
      {authenticated && correctChain && (
        <>
          {state.recoveryNotice && <p role="status">{state.recoveryNotice}</p>}
          {state.actionError && (
            <p role="alert">
              The DAO operation could not complete. Reconcile any saved request
              before continuing.
            </p>
          )}
          {state.transaction && (
            <p className="charity-digest" data-no-translate>
              Transaction: {state.transaction.hash} / {state.transaction.phase}
            </p>
          )}
          {state.transaction?.phase === "confirmed" && (
            <p role="status">{state.transaction.success}</p>
          )}
          {(state.transaction?.phase === "unknown" ||
            state.transaction?.phase === "pending") && (
            <button
              type="button"
              disabled={state.busy}
              onClick={() => void reconcile()}
            >
              Check transaction confirmation
            </button>
          )}
        </>
      )}
    </section>
  );
}
