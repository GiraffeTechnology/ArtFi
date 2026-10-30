"use client";
import { useState } from "react";
import {
  daoAvatarPalettes,
  isDaoPresentation,
  type DaoPresentation,
} from "@/lib/dao-presentation";
import styles from "./dao-presentation.module.css";

export function DaoPresentationFields({
  initial,
  legacy = false,
}: {
  initial?: DaoPresentation;
  legacy?: boolean;
}) {
  const [enabled, setEnabled] = useState(Boolean(initial) || !legacy);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [text, setText] = useState(initial?.avatar.text ?? "DAO");
  const [palette, setPalette] = useState(initial?.avatar.palette ?? "teal");
  return (
    <section className="field-span" aria-label="DAO presentation">
      <label>
        <input
          type="checkbox"
          name="daoPresentation"
          value="include"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Include DAO presentation
      </label>
      <p>
        This descriptive profile is saved with the creation request. It does not
        establish custody, membership or asset rights. Existing requests can
        keep their original profile-free configuration.
      </p>
      <fieldset disabled={!enabled} className={styles.fields}>
        <legend>Presentation details</legend>
        <label>
          Avatar letters or numbers (1–3)
          <input
            name="daoAvatarText"
            value={text}
            maxLength={6}
            required
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <label>
          Avatar colour
          <select
            name="daoAvatarPalette"
            value={palette}
            onChange={(event) => {
              const value = event.target.value;
              if (daoAvatarPalettes.some((entry) => entry === value))
                setPalette(value as typeof palette);
            }}
          >
            {daoAvatarPalettes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <textarea
            name="daoDescription"
            value={description}
            rows={4}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <p>
          {
            new TextEncoder().encode(
              description.replaceAll("\r\n", "\n").trim(),
            ).byteLength
          }{" "}
          / 2000 UTF-8 bytes. Plain text only; do not include private data.
        </p>
        <div aria-label="Avatar preview" className={styles.preview}>
          <span
            className={styles.avatar + " " + styles[palette]}
            aria-hidden="true"
          >
            {text}
          </span>
          <span>Presentation preview</span>
        </div>
      </fieldset>
    </section>
  );
}
export function DaoPresentationCard({
  presentation,
  name,
  symbol,
}: {
  presentation?: DaoPresentation;
  name: string;
  symbol: string;
}) {
  if (!presentation)
    return <p>No descriptive profile was included in this original request.</p>;
  if (!isDaoPresentation(presentation))
    return <p>DAO presentation could not be verified.</p>;
  return (
    <section aria-label="Saved DAO presentation" className={styles.card}>
      <div className={styles.preview}>
        <span
          className={styles.avatar + " " + styles[presentation.avatar.palette]}
          aria-hidden="true"
        >
          {presentation.avatar.text}
        </span>
        <h3>
          {name} ({symbol})
        </h3>
      </div>
      <p className={styles.description}>
        {presentation.description || "No description supplied."}
      </p>
      <p>
        Creation-request presentation. Current custody, roles and membership are
        verified separately.
      </p>
    </section>
  );
}
