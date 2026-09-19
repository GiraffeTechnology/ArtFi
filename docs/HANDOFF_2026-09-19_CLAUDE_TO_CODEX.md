# Handoff — 2026-09-19, supervision side to delivery side

| Field    | Value                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| Branch   | `claude/ci-all-pr-6dytk9`                                                      |
| Base     | `main` at `c614994`                                                            |
| Head     | `f9ef062`, plus one uncommitted change described in §6                         |
| Purpose  | So the delivery side does not rebuild what exists or re-decide what is decided |
| Standing | **Record only.** See §0                                                        |

## 0. What this document is not

This is an execution record. It is **priority 6** in the `AGENTS.md` §1 authority order —
historical material.

**It creates no requirement, gate, status value, delivery condition or scope item.** Where it
describes a rule, the rule's authority is #110 or the client ruling it cites, never this file. Where
it describes a gap, that gap is a finding, not a blocker: §5 lists what is genuinely waiting on the
client, and nothing else here blocks anything.

If this file and `docs/STATUS.md` disagree about evidence, `STATUS.md` is the newer record and wins.

---

## 1. Client rulings recorded on 2026-09-19

Four rulings landed this day. All are priority 2 and are already written into `AGENTS.md` §1.1
(invariants 6–9), `docs/PRD.md` and
[`DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md).
**Do not re-derive them and do not re-open them.**

1. **Venues.** All trading is available on both ArtFi and OpenSea; **ArtFi is primary**, and
   third-party venues are an early-stage state. Superseded the same day's earlier ruling that made
   OpenSea the sole whole-artwork venue.
2. **Two phases per product line.** Until a line opens on ArtFi, **ArtFi does mirroring only** for
   that line; once it opens, ArtFi also trades, settled by signature. The original PRD's `J-05` and
   `MARKET-004` describe that first phase correctly and are **not** a superseded position — earlier
   readings that recorded them as a conflict were wrong and are corrected.
   **Mirror-only describes what is switched on, never what may be written.**
3. **Delivery standard.** Staged delivery, and **every delivery is measured by what is visible and
   operable in the UI** (`PRD.md` §3.2). Only the complete RWA market is handed over whole. Visual
   design is the client's own track, being redone in Figma, and the delivered version is verified on
   **functional** delivery. **The production version is assembled once, at the end** — a stage
   carries no production build, deployment or go-live packaging, and **no agent may pull production
   work forward** (`PRD.md` §3.2.5).
4. **Holder authority.** For a registry-backed asset the **registry of record** is the holder
   authority and the chain is its projection; registries of record are a class, not a company;
   ArtFi treats ArtCCH as a third party and **operates no registry** (`PRD.md` §1.0.5).

One consequence worth stating because it changed an acceptance rule: mirroring **is** attributed
data plus a link out, so the deep link required by `PRD.md` §4.8 XM.4 stands. `ACCEPTANCE.md` §7.8
still reads that an external-marketplace redirect fails the audit; under the `AGENTS.md` §1 authority
order that file may record a higher source but never contradict one, so **on that one point §7.8
does not govern**. Every other item in §7.8 is untouched and still fails an audit. §7.8's text is
annotated, not rewritten — correcting the wording is the client's call.

---

## 2. What is already built on this branch — do not rebuild

Nine commits. Each row says what exists so it is not written twice.

| Commit    | What it delivered                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `63f01ef` | The three product lines, their venues, the phased rollout, the staged-delivery standard and the stage table (`PRD.md` §3.2)                                        |
| `d851b08` | **Charity surface.** `/charity` and `/charity/[tokenId]` reading the editions contract; CH.5 end to end including the watermarked-byte delivery that did not exist |
| `beeb576` | The charity surface refitted onto existing shared classes; bespoke CSS cut from ~155 lines to under 60                                                             |
| `2fa8f6a` | The production-assembly ruling                                                                                                                                     |
| `a612932` | The two-phase ruling, which settled the XM.4 deep link                                                                                                             |
| `f18228c` | **Mirror attribution.** Source, order ID, observed time, freshness and the venue link on every mirrored record, with the link re-validated and never constructed   |
| `0c1c652` | **XM.6.** Sale attribution fixed, and `accepted` made reachable                                                                                                    |
| `ea88ac7` | **Operator view.** `/operations`, read-only dependency status                                                                                                      |
| `f9ef062` | **Charity release verifier.** Formal-set enforcement, metadata-URI binding, and CH.11's packaging half                                                             |

### 2.1 Charity (`S-CH`)

- `/charity`, `/charity/[tokenId]` read `seriesCount`, `series()`, `totalSupply` and the
  distribution-wallet balance directly from the editions contract. Unset address or unreadable chain
  renders an unavailable state and lists nothing — **no fixture stands in for live data**.
- CH.5 runs from the page: challenge naming the edition → wallet signature → server-side check of
  both the signature and an ERC-1155 balance → the file.
- `charity-object-store.ts` signs a server-side S3 GET against a **private** store (separate from
  the public `R2_*` bucket on purpose), reads the whole object and verifies its SHA-256 against the
  reviewed descriptor **before emitting a byte**. `holder-asset/file/route.ts` serves it as an
  attachment.
- Release verifier: the formal set is `UNIT-A01` and `UNIT-A03`–`UNIT-A38`; `UNIT-A02` is rejected
  by name; the public metadata URI must end in the package's own artwork id; `holderAsset.file` and
  `holderAsset.sha256` are optional but never half-present, and a declared digest equal to the
  master's hard-fails in every mode.

### 2.2 External market (`S-XM`)

- `market-links.ts` re-validates a reported venue URL and refuses a non-HTTPS scheme, embedded
  credentials and any host but `opensea.io`. **ArtFi never constructs a link** — an absent
  `marketplaceUrl` renders as absent.
- `planIntentTransitions` is a pure function holding the reconciliation rules, so attribution is
  testable without a database.

### 2.3 Operations (`S-OPS`)

- `/operations` checks web runtime, API runtime, chain identity and head-block age, mirror freshness
  and the editions contract. It **stores nothing, queues nothing and notifies nobody**.
- It is **not** the monitor engine. That is PR #66 — a conflicted draft its own description marks
  do-not-merge. It was deliberately not duplicated and not merged.
- No endpoint, host, address or credential is rendered; a browser test asserts no URL, IPv4 or
  `localhost` string reaches the page.

---

## 3. Defects found and fixed — the reasoning, so it is not undone

Three of these were not on anyone's list. They are recorded here because a future change could
quietly reintroduce them.

1. **An external sale was reported to every intent on the order** (`0c1c652`). A sale event marked
   **every** non-terminal intent `confirmed`. An order fills once, so at most one of those intents
   belonged to the buyer — every other user was told their purchase succeeded while somebody else
   held the item. Now only the intent whose own `submitted_transaction_hash` the venue reported is
   confirmed; the rest fail with `external-order-filled-by-another-transaction`; a sale with no
   transaction hash confirms nobody; and **another party's transaction hash is never written into
   this user's row**, because the row would then read as if this wallet had sent it.
2. **The release verifier admitted the withdrawn `UNIT-A02`** (`f9ef062`). `^UNIT-A\d{2}$` accepted
   it, and `PRD.md` §8.4 requires the formal batch to hard-reject it while `ACCEPTANCE.md` §7.9
   fails the audit over it.
3. **A record grid clipped its own content** (`f18228c`). The mirror card's field row was a
   non-wrapping flex row sized for three fields; the two XM.4 required additions fell off the card.

---

## 4. Corrections to `docs/STATUS.md` — previous evidence text was wrong

Stated plainly so the delivery side does not act on the old text.

- **CH.11** claimed the verifier asserted that the watermarked holder file hashes differently from
  the master, in a full mode CI never ran. **Both halves were wrong.** The manifest carried no
  holder-file field, so nothing was ever compared, and CI does run full mode through
  `pnpm charity-edition:verifier:test`. Corrected, and the packaging half now exists.
- **CH.10** claimed CI runs `--schema-only` so full mode is unexercised. Wrong for the same reason.
- **`PRD.md` §1** recorded the original PRD as a superseded position conflicting with the current
  venue ruling. Wrong — it describes the mirror-only phase correctly. Corrected per §1.2 above.

---

## 5. Open client decisions — these are the only real blockers

None of them blocks engineering on anything else. Do not invent an answer to any of them.

| #   | Decision                                                                                              | Consequence                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **Registry-versus-chain divergence**: which way it resolves                                           | Determines how the M2.8 reconciliation is implemented. `PRD.md` §1.0.5 records it open                           |
| 2   | **Open item 6**: CH.1's 13-work first supply versus the 37 already minted                             | The verifier deliberately does **not** enforce the 13-work list; enforcing it would take a side                  |
| 3   | **`ACCEPTANCE.md` §7.8 wording**                                                                      | Annotated, not rewritten. The redirect clause does not govern; the text is the client's to correct               |
| 4   | **G1's visual baseline** once the Figma work lands                                                    | `pics/*.png` has never existed in this repository; M3.10 is the matrix's only `BLOCKED`                          |
| 5   | **Seventeen files still carrying real vendor names**, three of them code contract values (`hostRole`) | `docs/DEPLOYMENT_ENVIRONMENT.md` records this as a known deviation: one-command deletability is **not yet true** |
| 6   | **Alert notification target and channel** (open item 12)                                              | This is what gates M6.3. Local fixtures cannot supply delivery-to-a-person evidence                              |

---

## 6. Uncommitted work in progress

One change is in the working tree and **not yet pushed** at the time of writing:

- `prototype-data-notice.tsx` — a single disclosure component, rendered on `/`, `/projects`,
  `/projects/[slug]`, `/market/rwa/[slug]`, `/market/fractionals` and
  `/market/fractionals/[slug]`. `lib/catalog.ts` holds **six invented artworks by six invented
  artists**, with invented valuations and provenance, and until now no surface said so. `AGENTS.md`
  §5 forbids presenting fixtures as live behaviour and `ACCEPTANCE.md` §7.7 fails an audit over it.
- `asset-holder-authority.tsx` — the three-record standing on a whole-artwork page: registry of
  record (authority, **not connected in this build**), chain (projection), ArtFi's own store
  (authoritative for nothing).
- `prototype-disclosure.spec.ts` — 10 browser tests, including that the live mirror and the charity
  surface are **not** labelled as prototype data, and that a fraction page makes no whole-artwork
  holder claim.

Status: typecheck, lint, format and the spec itself pass on desktop; the full desktop-and-mobile
sweep had not been re-run when this was written. **This discloses; it does not fix.** M3.7 — the
real catalogue replacing the fixtures — stays `NOT-IMPLEMENTED` and this notice is not evidence
toward it.

`apps/web/playwright.local.config.ts` is a scratch file for running Playwright against this
environment's Chromium build. **It is not part of the delivery and must not be committed.**

---

## 7. Boundaries that apply to whoever picks this up

Restated from `AGENTS.md`, not added by it.

- **Do not promote a status value without evidence on the reviewed commit.** Every count on this
  branch stayed where it was. `VERIFIED` has not moved from 4/77 and nothing here earned it.
- **Do not pull production work forward.** CI/CD to production, the production cluster, replica and
  backup/restore are production assembly and belong to the client's final step.
- **Do not enforce an open decision in code.** §5 lists them. A verifier, a schema or a UI that
  picks a side decides it.
- **Do not present fixtures as live.** Where a fixture is used for presentation evidence, label it
  as one, as `market-unavailable.spec.ts` and the new specs do.
- **Do not duplicate PR #66.** The monitor engine is that draft's scope.
- **Report a gap; do not legislate it.** If no trace to #110 or a client ruling exists, it is not a
  requirement.

## 8. Reproducing the checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm charity-edition:verify-schema
pnpm charity-edition:verifier:test
pnpm charity-edition:ye-yongrun:verify
node scripts/security/check-secrets.mjs
node scripts/test/verify-chain-consistency.mjs
(cd apps/api && go vet ./... && go test -race ./...)
pnpm test:e2e            # desktop and mobile Chromium
```

Two things this environment could not run, recorded rather than skipped silently:

- the **MySQL integration tests**, which need `ARTFI_INTEGRATION_MYSQL_DSN` — no container runtime
  was available;
- any **on-chain** execution. There is still **no runtime chain evidence on any chain**, and the
  G2 runtime matrix on Hoodi remains the single cheapest step: it converts a large share of the 37
  `IMPLEMENTED-NOT-VERIFIED` items without a line of feature code.
