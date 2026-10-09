"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import {
  projectionReadMessages,
  projectionReadResponseSchema,
  projectionReadView,
  projectionUint64,
  type ProjectionRead,
  type ProjectionReadError,
  type ProjectionReadResponse,
} from "@/lib/oracle-projection-model";
import styles from "./asset-holder-authority.module.css";

function ReadFailure({ code }: { code: ProjectionReadError }) {
  return <span>{projectionReadMessages[code]}</span>;
}

function ProjectionFacts({ result }: { result: ProjectionRead }) {
  const entry = result.entry.ok ? result.entry.value : null;
  const viewsDiffer =
    entry &&
    result.holder.ok &&
    entry.holder.toLowerCase() !== result.holder.value.toLowerCase();
  const ownerDiffers =
    result.position.ok &&
    result.position.value &&
    result.holder.ok &&
    result.position.value.toLowerCase() !== result.holder.value.toLowerCase();
  return (
    <div data-testid="projection-facts">
      <dl className={styles.facts}>
        <div>
          <dt>Configured Oracle source binding</dt>
          <dd>
            Chain {result.source.chainId} · {result.source.contract} · Token{" "}
            {result.tokenId}
          </dd>
        </div>
        <div>
          <dt>Register identity</dt>
          <dd>{result.source.registerId}</dd>
        </div>
        <div>
          <dt>Queried instant</dt>
          <dd>{result.instant} Unix seconds</dd>
        </div>
        <div>
          <dt>Recorded holder at that instant</dt>
          <dd>
            {result.holder.ok ? (
              result.holder.value
            ) : (
              <ReadFailure code={result.holder.code} />
            )}
          </dd>
        </div>
        <div>
          <dt>Temporal finality at that instant</dt>
          <dd>
            {result.finality.ok ? (
              result.finality.value ? (
                "Final for the queried instant"
              ) : (
                "Not final for the queried instant"
              )
            ) : (
              <ReadFailure code={result.finality.code} />
            )}
          </dd>
        </div>
        <div>
          <dt>ERC-721 tradeable position</dt>
          <dd>
            {result.position.ok ? (
              (result.position.value ?? "Not read by Oracle")
            ) : (
              <ReadFailure code={result.position.code} />
            )}
          </dd>
        </div>
        <div>
          <dt>Observed entry count</dt>
          <dd>{result.entryCount}</dd>
        </div>
      </dl>
      {ownerDiffers && (
        <p className={styles.note}>
          The tradeable position differs from the recorded holder. These are
          separate facts; token transfer does not determine the register&apos;s
          answer.
        </p>
      )}
      {viewsDiffer && (
        <p role="status" className={styles.warning}>
          The entry and holder reads differ. They were separate reads. Refresh
          to inspect the updated observations; ArtFi does not choose one as
          authoritative.
        </p>
      )}
      <h4>Register entry at the queried instant</h4>
      {entry ? (
        <dl className={styles.facts}>
          <div>
            <dt>Entry version</dt>
            <dd>{entry.version}</dd>
          </div>
          <div>
            <dt>Entry holder</dt>
            <dd>{entry.holder}</dd>
          </div>
          <div>
            <dt>Effective at</dt>
            <dd>{entry.effectiveAt} Unix seconds</dd>
          </div>
          <div>
            <dt>Superseded at</dt>
            <dd>
              {entry.supersededAt === "0"
                ? "No successor is reported"
                : `${entry.supersededAt} Unix seconds`}
            </dd>
          </div>
          <div>
            <dt>Record commitment</dt>
            <dd>{entry.recordCommitment}</dd>
          </div>
          <div>
            <dt>Previous commitment</dt>
            <dd>{entry.previousCommitment}</dd>
          </div>
          <div>
            <dt>Registry reference</dt>
            <dd>{entry.registryReference}</dd>
          </div>
        </dl>
      ) : (
        !result.entry.ok && (
          <p>
            <ReadFailure code={result.entry.code} />
          </p>
        )
      )}
      <p className={styles.note}>
        Read completed at {result.readAt}. These are separate Oracle reads, not
        an atomic chain snapshot. A commitment or registry reference is not the
        underlying record or an independently verified legal-title claim.
      </p>
    </div>
  );
}

async function loadProjection(
  slug: string,
  instant: string,
  signal: AbortSignal,
  sourceCatalog = false,
): Promise<ProjectionReadResponse> {
  try {
    const response = await fetch(
      `/api/${sourceCatalog ? "rwa/assets" : "assets"}/${encodeURIComponent(slug)}/projection?instant=${encodeURIComponent(instant)}`,
      { cache: "no-store", signal },
    );
    const result = projectionReadResponseSchema.safeParse(
      await response.json(),
    );
    return result.success &&
      (!result.data.ok || (response.ok && result.data.instant === instant))
      ? result.data
      : { ok: false, code: "PROJECTION_SOURCE_MALFORMED" };
  } catch {
    return { ok: false, code: "PROJECTION_READ_UNAVAILABLE" };
  }
}

/** Reads Oracle's application API only; never requests a wallet or a write. */
export function OracleProjectionPanel({
  slug,
  sourceCatalog = false,
}: {
  slug: string;
  sourceCatalog?: boolean;
}) {
  const [instant, setInstant] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const query = useQuery({
    queryKey: [
      "whole-artwork-projection",
      sourceCatalog ? "source" : "sample",
      slug,
      instant,
    ],
    queryFn: ({ signal }) =>
      loadProjection(
        slug,
        instant ?? Math.floor(Date.now() / 1000).toString(),
        signal,
        sourceCatalog,
      ),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const view = projectionReadView(query);
  const loading = view.phase === "loading";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = draft.trim();
    if (!projectionUint64.safeParse(candidate).success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (candidate === instant) void query.refetch();
    else setInstant(candidate);
  }
  return (
    <section aria-label="ERC-8415 register projection" className={styles.panel}>
      <div className={styles.heading}>
        <h3>Register holder &amp; temporal history</h3>
        <button
          type="button"
          disabled={loading}
          onClick={() => void query.refetch()}
        >
          {loading
            ? "Reading register projection…"
            : "Refresh register projection"}
        </button>
      </div>
      <p>
        Read the recorded holder, temporal finality and ERC-721 position
        separately through Oracle. These reads grant no minting, trading,
        physical-delivery or redemption authority. This projection-only
        interface does not report settlement gaps. The source chain and
        collection are Oracle deployment configuration, not a cryptographic
        claim from these HTTP reads. The initial read queries the current Unix
        time; its exact instant is shown with the result.
      </p>
      <form onSubmit={submit} className={styles.projectionForm}>
        <label htmlFor={`projection-instant-${slug}`}>
          Historical instant (Unix seconds)
        </label>
        <input
          id={`projection-instant-${slug}`}
          inputMode="numeric"
          placeholder="Current instant on initial read"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          aria-invalid={invalid}
        />
        <button type="submit" disabled={loading}>
          Read this instant
        </button>
      </form>
      {invalid && <p role="alert">{projectionReadMessages.INSTANT_INVALID}</p>}
      {view.phase === "paused" ? (
        <p role="status" data-testid="projection-offline">
          You appear to be offline. The projection read is paused and previous
          facts are hidden. Reconnect to resume or retry.
        </p>
      ) : loading ? (
        <p role="status">
          Reading this artwork&apos;s bound register projection…
        </p>
      ) : view.result?.ok ? (
        <ProjectionFacts result={view.result} />
      ) : (
        <p role="status" data-testid="projection-unavailable">
          <ReadFailure
            code={
              view.result && !view.result.ok
                ? view.result.code
                : "PROJECTION_READ_UNAVAILABLE"
            }
          />
        </p>
      )}
      <p className={styles.note}>
        Finality answers whether the register&apos;s answer for the queried
        instant can still change. It is not freshness, chain economic finality
        or proof of physical title.
      </p>
    </section>
  );
}
