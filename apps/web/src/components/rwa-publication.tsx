"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useUserSession } from "./user-session-provider";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import { currentOperation } from "@/lib/current-operation";
import {
  parsePendingPublication,
  parsePublicAsset,
  parseSourceEvidence,
  rwaPublicationSchema,
  type RWAPublication,
  type RWAPublicationReview,
} from "@/lib/rwa-publication";
import { rwaAssetSchema, type RwaAsset } from "@/lib/rwa-catalog";
import type { UserSession } from "@/lib/user-session-client-state";
import styles from "./rwa-publication.module.css";
export function RWAPublicationForm() {
  const auth = useUserSession();
  const wallet = useAccount();
  const key = portfolioSessionKey(auth, wallet);
  if (!key || !auth.session || auth.session.chainId !== 560048)
    return (
      <section className={styles.panel}>
        <h2>Sign in to publish source-verified assets</h2>
        <p>
          Use your Hoodi wallet session. Connecting a wallet alone is not
          sign-in. Any authenticated participant can submit valid
          approved-source evidence; no ArtFi administrator approval is required.
        </p>
      </section>
    );
  return <PrivatePublication key={key} session={auth.session} />;
}
function PrivatePublication({ session }: { session: UserSession }) {
  const storageKey = `artfi:rwa-publication:${session.chainId}:${session.address.toLowerCase()}`;
  // This private component mounts only after the session provider authenticates
  // in the browser. Restored data is strictly validated before use or forwarding.
  const [pending, setPending] = useState<
    { key: string; body: RWAPublication } | undefined
  >(() => {
    try {
      const text =
        typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem(storageKey)
          : null;
      return text ? parsePendingPublication(text) : undefined;
    } catch {
      return undefined;
    }
  });
  const [assetText, setAssetText] = useState(() =>
    pending ? JSON.stringify(pending.body.asset, null, 2) : "",
  );
  const [evidenceText, setEvidenceText] = useState(() =>
    pending ? JSON.stringify(pending.body.evidence, null, 2) : "",
  );
  const [revision, setRevision] = useState(pending?.body.revision ?? 0);
  const [review, setReview] = useState<RWAPublicationReview>();
  const [result, setResult] = useState<RwaAsset>();
  const [message, setMessage] = useState(
    pending
      ? "A prior publication request is saved. Review its exact public contents, then retry the same request to learn its durable result."
      : "",
  );
  const [busy, setBusy] = useState(false);
  const lease = useRef(false);
  const view = useRef(currentOperation());
  useEffect(() => {
    view.current = currentOperation();
    const active = view.current;
    const retire = () => active.retire();
    window.addEventListener("pagehide", retire);
    window.addEventListener("popstate", retire);
    return () => {
      retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("popstate", retire);
    };
  }, [storageKey]);
  async function call(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    key: string,
  ) {
    if (session.expiresAt <= Date.now())
      throw new Error("Sign in again before publishing.");
    const response = await fetch(`/api/rwa/publication/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-artfi-wallet": session.address,
        "x-artfi-chain": String(session.chainId),
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        value.detail || "No publication was confirmed. Retry the same request.",
      );
    return value;
  }
  async function prepare() {
    if (lease.current) return;
    lease.current = true;
    setBusy(true);
    setMessage("");
    const op = view.current;
    try {
      const asset = parsePublicAsset(assetText);
      const value = await call("drafts", "POST", asset, crypto.randomUUID());
      op.assertCurrent();
      if (value.executable !== false || value.contextHash?.length !== 66)
        throw new Error("The source-review commitment is invalid.");
      setReview(value);
      setResult(undefined);
      setMessage(
        "The public metadata and binding are ready for the approved source to review. This unsigned proposal does not activate an asset.",
      );
    } catch (error) {
      if (op.isCurrent())
        setMessage(
          error instanceof Error
            ? error.message
            : "The proposal could not be prepared.",
        );
    } finally {
      lease.current = false;
      if (op.isCurrent()) setBusy(false);
    }
  }
  async function publish() {
    if (lease.current) return;
    lease.current = true;
    setBusy(true);
    setMessage("");
    const op = view.current;
    try {
      let request = pending;
      if (!request) {
        if (!review)
          throw new Error("Prepare and review the public metadata first.");
        const asset = parsePublicAsset(assetText);
        const evidence = parseSourceEvidence(evidenceText);
        if (
          JSON.stringify(asset) !== JSON.stringify(review.asset) ||
          evidence.contextHash !== review.contextHash
        )
          throw new Error(
            "This source evidence does not bind the reviewed public metadata. Request a matching source claim.",
          );
        const body = rwaPublicationSchema.parse({ revision, asset, evidence });
        request = { key: crypto.randomUUID(), body };
        // Validate before either storage or transmission, including every nested key.
        sessionStorage.setItem(storageKey, JSON.stringify(request));
        setPending(request);
      }
      const value = await call(
        `assets/${request.body.asset.slug}`,
        "PUT",
        request.body,
        request.key,
      );
      op.assertCurrent();
      const confirmed = rwaAssetSchema.parse(value);
      if (
        confirmed.slug !== request.body.asset.slug ||
        confirmed.grounding.evidenceId !== request.body.evidence.evidenceId
      )
        throw new Error(
          "The publication response does not match the submitted source claim.",
        );
      setResult(confirmed);
      setPending(undefined);
      sessionStorage.removeItem(storageKey);
      setMessage(
        "Source verification and public catalog publication are recorded. This does not transfer a token or establish a completed physical delivery.",
      );
    } catch (error) {
      if (op.isCurrent())
        setMessage(
          error instanceof Error
            ? error.message
            : "No publication was confirmed. Retry the saved request.",
        );
    } finally {
      lease.current = false;
      if (op.isCurrent()) setBusy(false);
    }
  }
  function reset() {
    if (busy) return;
    view.current.retire();
    view.current = currentOperation();
    setPending(undefined);
    setReview(undefined);
    setResult(undefined);
    setMessage("");
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* No external state is changed by clearing local draft recovery. */
    }
  }
  const selected = pending?.body.asset ?? review?.asset;
  return (
    <div
      className={styles.layout}
      data-no-translate="true"
      data-translation-skip="true"
    >
      <section className={styles.panel}>
        <h2>Public asset record</h2>
        <p>
          Only publish information intended for the public catalog. Do not enter
          a source private key, seed, API token, confidential document or
          personal identity record.
        </p>
        <label>
          Public asset metadata (JSON)
          <textarea
            rows={15}
            value={assetText}
            onChange={(event) => {
              setAssetText(event.target.value);
              setReview(undefined);
              setResult(undefined);
            }}
            disabled={busy || Boolean(pending)}
            spellCheck={false}
          />
        </label>
        <label>
          Current catalog revision
          <input
            type="number"
            min={0}
            step={1}
            value={revision}
            onChange={(event) => setRevision(Number(event.target.value))}
            disabled={busy || Boolean(pending)}
          />
          <small>
            Use 0 for a new record. For an update, use the revision displayed on
            the asset detail page.
          </small>
        </label>
        <button
          className="button button-secondary"
          disabled={busy || Boolean(pending) || !assetText.trim()}
          onClick={() => void prepare()}
        >
          Prepare public source-review draft
        </button>
        {review && (
          <label>
            Unsigned context commitment
            <input readOnly value={review.contextHash} />
            <textarea
              aria-label="Unsigned public source-review draft"
              readOnly
              rows={8}
              value={JSON.stringify(review, null, 2)}
            />
          </label>
        )}
        <label>
          Signed source evidence (JSON)
          <textarea
            rows={12}
            value={evidenceText}
            onChange={(event) => setEvidenceText(event.target.value)}
            disabled={busy || Boolean(pending)}
            spellCheck={false}
          />
        </label>
        <p className={styles.note}>
          Approved sources sign the exact model, underlying asset,
          token/vault/market binding, rights, source reference and validity.
          ArtFi verifies public P-256 signatures; it never signs on a source’s
          behalf.
        </p>
        <div className={styles.actions}>
          <button
            className="button button-primary"
            disabled={
              busy ||
              Boolean(result) ||
              (!pending && (!review || !evidenceText.trim()))
            }
            onClick={() => void publish()}
          >
            {busy
              ? "Verifying…"
              : pending
                ? "Retry saved publication"
                : "Verify source and publish public record"}
          </button>
          <button
            className="button button-secondary"
            disabled={busy}
            onClick={reset}
          >
            Return to editable draft
          </button>
        </div>
        {message && <p role="status">{message}</p>}
        {result && (
          <p>
            <Link
              href={
                result.section === "whole"
                  ? `/rwa/assets/${result.slug}`
                  : `/market/fractionals/assets/${result.slug}`
              }
            >
              Open published {result.title}
            </Link>
          </p>
        )}
      </section>
      <aside className={styles.panel}>
        <h2>Review public rights and binding</h2>
        {selected ? (
          <>
            <h3>{selected.title}</h3>
            <p>
              {selected.artist} · {selected.year} · {selected.section}
            </p>
            <p>{selected.rights}</p>
            <dl>
              <dt>Chain</dt>
              <dd>{selected.binding.chainId}</dd>
              <dt>Collection / token</dt>
              <dd>
                {selected.binding.collectionAddress} /{" "}
                {selected.binding.tokenId}
              </dd>
              <dt>Underlying identity</dt>
              <dd>{selected.binding.underlyingAssetId}</dd>
              {selected.binding.fractionTokenAddress && (
                <>
                  <dt>Fraction token</dt>
                  <dd>{selected.binding.fractionTokenAddress}</dd>
                  <dt>Vault</dt>
                  <dd>{selected.binding.vaultAddress}</dd>
                </>
              )}
              {selected.binding.marketAddress && (
                <>
                  <dt>Settlement contract</dt>
                  <dd>{selected.binding.marketAddress}</dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <p>
            Prepare the public metadata to inspect exactly what the approved
            source will authenticate.
          </p>
        )}
        <p>
          Whole artwork receipts remain ERC-8415 delivery vouchers or warehouse
          receipts. Fractional rights follow the approved underlying structure.
          Public catalog publication is separate from chain ownership, registry
          holdership and physical delivery.
        </p>
        <p>
          TEST_ONLY records are TESTNET · NO REAL-WORLD VALUE · NO LEGAL EFFECT.
        </p>
        <p>Digital charity editions do not use this RWA approval workflow.</p>
      </aside>
    </div>
  );
}
