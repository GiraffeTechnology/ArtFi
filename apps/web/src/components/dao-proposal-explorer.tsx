"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAddress, type PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import { supportedChain } from "@/lib/wagmi";
import {
  earlierProposalRange,
  proposalBlockInput,
  publicProposalKinds,
  publicProposalStates,
  readPublicProposalPage,
  type PublicProposalPage,
  type ProposalRange,
} from "@/lib/dao-proposal-discovery";
export function DaoProposalExplorer({
  governorAddress,
}: {
  governorAddress?: string;
}) {
  const client = usePublicClient({ chainId: supportedChain.id });
  return (
    <ProposalExplorerSession
      key={`${governorAddress}:${client?.uid ?? ""}`}
      governorAddress={governorAddress}
      client={client}
    />
  );
}
function ProposalExplorerSession({
  governorAddress,
  client,
}: {
  governorAddress?: string;
  client?: PublicClient;
}) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [page, setPage] = useState<PublicProposalPage>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(0),
    controller = useRef<AbortController | undefined>(undefined),
    gate = useRef(false);
  useEffect(
    () => () => {
      active.current++;
      controller.current?.abort();
      gate.current = false;
    },
    [],
  );
  const configured =
    isAddress(governorAddress ?? "") &&
    !/^0x0{40}$/i.test(governorAddress ?? "");
  function cancel() {
    active.current++;
    controller.current?.abort();
    gate.current = false;
    setBusy(false);
    setPage(undefined);
  }
  async function read(mode: "recent" | "selected" | "earlier") {
    if (!configured || !client || gate.current) return;
    const previous = page,
      generation = ++active.current,
      attempt = new AbortController();
    controller.current?.abort();
    controller.current = attempt;
    gate.current = true;
    setBusy(true);
    setError("");
    setPage(undefined);
    try {
      let range: ProposalRange | undefined;
      if (mode === "selected")
        range = {
          fromBlock: proposalBlockInput(from),
          toBlock: proposalBlockInput(to),
        };
      if (mode === "earlier") {
        if (!previous) throw new Error("Read a block range first.");
        range = earlierProposalRange(BigInt(previous.fromBlock));
        if (!range)
          throw new Error("The previous range already began at block zero.");
      }
      const result = await readPublicProposalPage(
        client,
        governorAddress!,
        range,
        { signal: attempt.signal },
      );
      if (generation !== active.current || attempt.signal.aborted) return;
      setPage(result);
      setFrom(result.fromBlock);
      setTo(result.toBlock);
    } catch {
      if (generation === active.current && !attempt.signal.aborted)
        setError(
          "The proposal range is unavailable or exceeds its bounds. Check the block numbers, choose at most 10,000 blocks and retry. No empty or successful result is inferred.",
        );
    } finally {
      if (generation === active.current) {
        gate.current = false;
        setBusy(false);
        controller.current = undefined;
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void read("selected");
  }
  return (
    <section className="dao-panel" aria-label="Public DAO proposal discovery">
      <h2>Discover classified proposals</h2>
      <p>
        Read public proposal IDs and recorded outcomes from the configured Hoodi
        Governor. No wallet login or signature is required for this read-only
        view.
      </p>
      {!configured && (
        <p role="status">
          The Governor address is not configured. No alternate contract or
          sample proposal is substituted.
        </p>
      )}
      {configured && (
        <p className="charity-digest">
          Governor: <span data-no-translate>{governorAddress}</span>
        </p>
      )}
      {configured && !client && (
        <p role="status">
          The Hoodi read client is unavailable. No proposal result is assumed.
        </p>
      )}
      <form className="field-grid" onSubmit={submit}>
        <label>
          First block
          <input
            inputMode="numeric"
            maxLength={78}
            value={from}
            disabled={busy}
            onChange={(event) => {
              cancel();
              setError("");
              setFrom(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          Last block, inclusive
          <input
            inputMode="numeric"
            maxLength={78}
            value={to}
            disabled={busy}
            onChange={(event) => {
              cancel();
              setError("");
              setTo(event.currentTarget.value);
            }}
          />
        </label>
        <button
          type="submit"
          disabled={!configured || !client || busy || !from || !to}
        >
          Read selected range
        </button>
      </form>
      <div className="dao-actions-row">
        <button
          type="button"
          disabled={!configured || !client || busy}
          onClick={() => void read("recent")}
        >
          Read recent 10,000 blocks
        </button>
        <button
          type="button"
          disabled={!page || page.fromBlock === "0" || busy}
          onClick={() => void read("earlier")}
        >
          Read earlier block range
        </button>
        {busy && (
          <button type="button" onClick={cancel}>
            Cancel proposal read
          </button>
        )}
      </div>
      {busy && (
        <p role="status">
          Reading classified events and one-block proposal outcomes…
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {page && <PublicProposalResults page={page} />}
      <p>
        Each request covers at most 10,000 blocks and 100 classified proposals.
        A larger response is refused, not truncated. Short or empty ranges do
        not prove the end of proposal history. Provider completeness and live
        availability still require independent verification.
      </p>
    </section>
  );
}
export function PublicProposalResults({ page }: { page: PublicProposalPage }) {
  return (
    <div>
      <p>
        Classified-event range{" "}
        <span data-no-translate>
          {page.fromBlock}–{page.toBlock}
        </span>
        . States and vote units observed at Hoodi block{" "}
        <span data-no-translate>{page.observedBlock}</span>.
      </p>
      <p className="charity-digest">
        Observation block hash:{" "}
        <span data-no-translate>{page.observedBlockHash}</span>
      </p>
      <p>
        Browser observation time:{" "}
        <time
          data-no-translate
          dateTime={new Date(page.observedAt).toISOString()}
        >
          {new Date(page.observedAt).toISOString()}
        </time>
        . This snapshot is not reserved availability or finality; re-read for a
        newer observation.
      </p>
      {!page.proposals.length && (
        <p>
          No classified proposal was returned in this range. Other block ranges
          have not been searched.
        </p>
      )}
      <ol>
        {page.proposals.map((proposal) => (
          <li key={proposal.proposalId}>
            <h3>{publicProposalKinds[proposal.kind]}</h3>
            <p>
              Proposal ID:{" "}
              <span className="charity-digest" data-no-translate>
                {proposal.proposalId}
              </span>
            </p>
            <p>Observed state: {publicProposalStates[proposal.state]}</p>
            <p>
              Raw vote units: for{" "}
              <span data-no-translate>{proposal.forVotes}</span>, against{" "}
              <span data-no-translate>{proposal.againstVotes}</span>, abstain{" "}
              <span data-no-translate>{proposal.abstainVotes}</span>.
            </p>
            <p>
              Classified approval numerator:{" "}
              <span data-no-translate>{proposal.approvalNumerator}</span> /
              1,000,000. Strict approval and snapshot rules are evaluated by the
              Governor, not inferred from these counts.
            </p>
            <p>
              Classification block{" "}
              <span data-no-translate>{proposal.classifiedBlock}</span>, log{" "}
              <span data-no-translate>{proposal.logIndex}</span>.
            </p>
            <p className="charity-digest">
              Source block:{" "}
              <span data-no-translate>{proposal.classifiedBlockHash}</span>
              <br />
              Transaction:{" "}
              <span data-no-translate>{proposal.transactionHash}</span>
            </p>
          </li>
        ))}
      </ol>
      <p>
        Use an exact proposal ID in the existing governance panel to inspect or
        vote under its original membership rules. This list does not import
        execution packages, grant voting power, execute a physical action, debit
        a holder or settle a buyout.
      </p>
    </div>
  );
}
