"use client";

import { useState } from "react";
import {
  createDaoProposalDraft,
  daoDraftForm,
  daoDraftMaxBytes,
  parseDaoProposalDraft,
  serializeDaoProposalDraft,
  type DaoDraftContext,
  type DaoDraftForm,
  type DaoProposalDraft,
} from "@/lib/dao-proposal-draft";

export function DaoProposalDraftWorkspace({
  expected,
  currentForm,
  disabled,
  onApply,
}: {
  expected: DaoDraftContext;
  currentForm: DaoDraftForm;
  disabled: boolean;
  onApply: (form: DaoDraftForm) => void;
}) {
  const [input, setInput] = useState("");
  const [reviewed, setReviewed] = useState<DaoProposalDraft>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  function review(source: "form" | "import") {
    try {
      const draft =
        source === "form"
          ? createDaoProposalDraft(expected, currentForm)
          : parseDaoProposalDraft(input, expected);
      setReviewed(draft);
      setError("");
      setNotice(
        source === "form"
          ? "The current form was copied into an unsigned draft."
          : "The imported draft is ready for review. The proposal form has not changed.",
      );
    } catch (caught) {
      setReviewed(undefined);
      setNotice("");
      setError(
        caught instanceof Error
          ? caught.message
          : "The draft could not be reviewed.",
      );
    }
  }
  function download() {
    if (!reviewed) return;
    try {
      const text = serializeDaoProposalDraft(reviewed, expected);
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "artfi-dao-draft.json";
      try {
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setError("");
      setNotice(
        "The reviewed unsigned draft was prepared for download. Store or share it only where you intend.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The draft download could not be prepared.",
      );
    }
  }
  function apply() {
    if (!reviewed || disabled) return;
    try {
      // Revalidate the target immediately before filling fields. Applying never
      // creates a proposal, verifies evidence, signs or submits a transaction.
      const validated = parseDaoProposalDraft(
        serializeDaoProposalDraft(reviewed, expected),
        expected,
      );
      onApply(daoDraftForm(validated));
      setError("");
      setNotice(
        "The reviewed draft now fills the proposal form. Review it there; creating a proposal still requires the existing membership, chain and wallet checks.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The draft could not be applied.",
      );
    }
  }
  return (
    <section className="dao-panel" aria-labelledby="dao-draft-title">
      <p className="approved-eyebrow">Off-chain preparation</p>
      <h2 id="dao-draft-title">Proposal draft workspace</h2>
      <p>
        Prepare a proposal without a wallet signature. Drafts are kept in this
        page only until you download them. A draft is not a submitted proposal,
        verified evidence, a vote or permission to execute.
      </p>
      <p>
        Use the proposal fields below, then review a draft copy. You can also
        paste a previously exported JSON draft. Imports must match this chain
        and all four configured DAO addresses.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => review("form")}
        disabled={disabled}
      >
        Review draft from proposal form
      </button>
      <details>
        <summary>Import an unsigned draft</summary>
        <label>
          Draft JSON
          <textarea
            data-no-translate
            value={input}
            maxLength={daoDraftMaxBytes}
            rows={8}
            spellCheck={false}
            onChange={(event) => {
              setInput(event.currentTarget.value);
              setReviewed(undefined);
              setError("");
              setNotice("");
            }}
          />
        </label>
        <p>
          Only proposal terms are accepted. Signatures, transaction packages,
          arbitrary calldata and unsupported fields are refused.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => review("import")}
          disabled={disabled}
        >
          Review imported draft
        </button>
      </details>
      {reviewed ? (
        <div aria-label="Reviewed unsigned proposal draft">
          <h3>Review exact draft terms</h3>
          <p>
            Addresses and evidence references below are draft data. ArtFi has
            not authenticated the author, checked the evidence contents or
            established proposal eligibility.
          </p>
          <dl className="dao-metrics">
            <div>
              <dt>Chain</dt>
              <dd data-no-translate>{reviewed.context.chainId}</dd>
            </div>
            <div>
              <dt>Governor</dt>
              <dd data-no-translate>{reviewed.context.governor}</dd>
            </div>
            <div>
              <dt>Voting token</dt>
              <dd data-no-translate>{reviewed.context.token}</dd>
            </div>
            <div>
              <dt>Vault</dt>
              <dd data-no-translate>{reviewed.context.vault}</dd>
            </div>
            <div>
              <dt>Action registry</dt>
              <dd data-no-translate>{reviewed.context.actionRegistry}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd data-no-translate>{reviewed.action.type}</dd>
            </div>
          </dl>
          <label>
            Complete unsigned draft
            <textarea
              data-no-translate
              readOnly
              rows={16}
              value={JSON.stringify(reviewed, null, 2)}
              spellCheck={false}
            />
          </label>
          <p>
            Buyout drafts describe initiation terms only. They do not establish
            pricing evidence, transfer assets, debit holders or settle a buyout.
          </p>
          <div className="dao-actions-row">
            <button type="button" className="secondary" onClick={download}>
              Download reviewed draft
            </button>
            <button type="button" onClick={apply} disabled={disabled}>
              Fill proposal form from reviewed draft
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="dao-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="dao-status" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
