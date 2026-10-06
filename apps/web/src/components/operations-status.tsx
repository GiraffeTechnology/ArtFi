"use client";

import { useCallback, useEffect, useState } from "react";
import { isAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";

import { charityEditionsAbi } from "@/lib/contracts";
import {
  classifyApiRuntime,
  classifyChain,
  classifyContract,
  classifyMirror,
  classifyWebRuntime,
  summarise,
  type CheckVerdict,
} from "@/lib/ops-checks";
import { supportedChain } from "@/lib/wagmi";

/**
 * The operator's read-only view — #110 §2 M6.3.
 *
 * What this is **not**, stated first because the distinction is the whole design:
 *
 *   - It is not the monitor engine. Durable probing, an incident queue and notifier contracts are a
 *     separate slice (#66) that is not in this branch. Nothing here is duplicated from it.
 *   - It is not alerting. It stores nothing, queues nothing and notifies nobody. A reload re-reads
 *     reality; there is no state for an operator to acknowledge or clear.
 *
 * What it is: every dependency this build actually depends on, checked now, reported as observed.
 * A check that could not run says so — `ACCEPTANCE.md` §3 excludes an operator statement without
 * evidence, and a status page that renders silence as green is precisely that statement.
 *
 * **No endpoint, host, address or credential is ever rendered.** `ACCEPTANCE.md` §7.8 fails the
 * audit if the public UI exposes a prohibited IP or internal topology, so this page names roles and
 * outcomes only — "the API", not where it is.
 */

const apiURL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

type Row = {
  id: string;
  label: string;
  scope: string;
  verdict: CheckVerdict;
};

export function OperationsStatus() {
  const publicClient = usePublicClient({ chainId: supportedChain.id });
  const configuredAddress =
    process.env.NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS;
  const editionsAddress = (
    isAddress(configuredAddress ?? "") ? configuredAddress : undefined
  ) as Address | undefined;

  const [rows, setRows] = useState<Row[]>([]);
  const [checkedAt, setCheckedAt] = useState<string>();
  const [running, setRunning] = useState(true);

  const run = useCallback(async () => {
    setRunning(true);

    const web = await fetch("/api/health", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);

    const api = await fetch(`${apiURL}/healthz`, { cache: "no-store" })
      .then((response) => ({ reachable: true, status: response.status }))
      .catch(() => ({ reachable: false, status: undefined }));

    const chain = publicClient
      ? await (async () => {
          const [chainId, block] = await Promise.all([
            publicClient.getChainId(),
            publicClient.getBlock(),
          ]);
          return {
            chainId,
            blockNumber: block.number ?? 0n,
            blockTimestampSeconds: Number(block.timestamp),
          };
        })().catch(() => undefined)
      : undefined;

    const mirror = await fetch(
      `${apiURL}/v1/market/assets?source=opensea&page=1&pageSize=1`,
      { cache: "no-store" },
    )
      .then((response) => (response.ok ? response.json() : undefined))
      .then(
        (body) =>
          (body as { data?: { latestEventTimestamp?: string }[] } | undefined)
            ?.data?.[0]?.latestEventTimestamp,
      )
      .catch(() => undefined);

    const editionsReadable = editionsAddress
      ? await publicClient
          ?.readContract({
            abi: charityEditionsAbi,
            address: editionsAddress,
            functionName: "seriesCount",
          })
          .then(() => true)
          .catch(() => false)
      : undefined;

    const nowMs = Date.now();
    setRows([
      {
        id: "web",
        label: "Web runtime",
        scope: "This application",
        verdict: classifyWebRuntime(web),
      },
      {
        id: "api",
        label: "API runtime",
        scope: "Read-only API",
        verdict: classifyApiRuntime(api.reachable, api.status),
      },
      {
        id: "chain",
        label: "Chain",
        scope: `${supportedChain.name} ${supportedChain.id}`,
        verdict: classifyChain(
          chain,
          supportedChain.id,
          Math.floor(nowMs / 1000),
        ),
      },
      {
        id: "mirror",
        label: "External market mirror",
        scope: "Freshness of the newest observation",
        verdict: classifyMirror(mirror, nowMs),
      },
      {
        id: "editions",
        label: "Charity editions contract",
        scope: "Configured address answers a read",
        verdict: classifyContract(Boolean(editionsAddress), editionsReadable),
      },
    ]);
    setCheckedAt(new Date(nowMs).toISOString());
    setRunning(false);
  }, [editionsAddress, publicClient]);

  useEffect(() => {
    const timer = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(timer);
  }, [run]);

  const summary = summarise(rows.map((row) => row.verdict));

  return (
    <section className="ops-status" data-testid="operations-status">
      <div
        className="market-runtime-state"
        data-state={summary.state}
        role="status"
      >
        <strong>
          {running ? "Checking dependencies" : `Summary: ${summary.state}`}
        </strong>
        <span>{running ? "Reading each source now." : summary.detail}</span>
        <span>
          {checkedAt
            ? `Checked ${new Date(checkedAt).toLocaleString()}`
            : "Not yet checked"}
        </span>
        <button
          className="secondary"
          disabled={running}
          onClick={() => void run()}
        >
          Re-check
        </button>
      </div>

      <table className="ops-table">
        <caption>
          Each row is read when this page is opened. Nothing is stored and no
          alert is raised.
        </caption>
        <thead>
          <tr>
            <th scope="col">Dependency</th>
            <th scope="col">Checked</th>
            <th scope="col">State</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>No check has completed yet.</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr data-testid={`ops-row-${row.id}`} key={row.id}>
                <th scope="row">{row.label}</th>
                <td>{row.scope}</td>
                <td data-state={row.verdict.state}>{row.verdict.state}</td>
                <td>{row.verdict.detail}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <p className="market-gate">
        <strong>Not covered by this page.</strong> Log aggregation, alerting and
        the durable probe-and-incident engine are M6.3 work that is not in this
        build, and nothing here should be read as evidence for them. CI/CD to
        staging and production, and the production cluster with its replica and
        backup/restore, are production assembly — a client-scheduled step, not
        part of a stage.
      </p>
    </section>
  );
}
