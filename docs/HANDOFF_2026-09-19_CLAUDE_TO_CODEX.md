# Handoff — 2026-09-19, supervision side to delivery side

| Field    | Value                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| Branch   | `claude/ci-all-pr-6dytk9`                                                      |
| Base     | `main` at `c614994`                                                            |
| Head     | Branch tip — working tree clean, nothing outstanding                           |
| Purpose  | So the delivery side does not rebuild what exists or re-decide what is decided |
| Standing | **Record only.** See §0                                                        |

> **Why the head is named as a branch tip and not a SHA, and why no commit count appears.** This
> file's own commit is the head, and that SHA does not exist while the line is being written; a
> count including it drifts with every correction to this file. `docs/STATUS.md` states the same
> rule for its change log: a row cannot name its own merge. `git log --oneline c614994..` is the
> authoritative list.

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

The commits below are the delivery content, each row saying what exists so it is not written
twice. `git log --oneline c614994..` also carries later corrections to this file itself, which are
metadata about the record rather than delivery.

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
| `0268f05` | **Fixture disclosure and holder authority.** The prototype-data notice on every fixture-backed surface, and the three-record standing on a whole-artwork page      |
| `463d67c` | This handoff record                                                                                                                                                |

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

## 5. What is actually outstanding — and what is not a blocker

**Client ruling of 2026-09-19: do not treat a client decision as a blocker. The client does not
rule on technical questions.** An earlier version of this section listed six "open client
decisions". That framing was wrong and is replaced. Three of those six were technical questions
already answered by the documents — they are now decided and written down. The rest are not
decisions at all: they are **missing inputs**, things only the client's side can physically supply.

### 5.1 Decided from the documents, not referred upward

| Question                             | Resolution                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry-versus-chain divergence     | Not a tie. `PRD.md` §1.0.5 already gives each record a different question — registry answers who holds it, chain answers what settled. ArtFi reports both, substitutes neither, and answers neither from its own projection. Written out in §1.0.5 |
| Open item 6: 13 works versus 37      | Not a conflict. CH.1 says the **first** supply is 13; §8.4 says the **formal set** is 37. All 13 are inside the 37 and none is `UNIT-A02`. **13 is the first tranche of the 37.** Item 6 is closed                                                 |
| `ACCEPTANCE.md` §7.8's redirect item | Removed, not suspended. An audit item that forbids what a requirement mandates cannot be an audit condition. Every other exposure listed there still fails an audit                                                                                |

Each is read from text that already existed. If the client intends a different reading, the cited
section is where it is corrected — but none of them waits on that.

### 5.2 Missing inputs — nothing to decide, something to supply

These are not rulings. No reading of the documents produces them, and no agent can invent them.

| Input                                                                  | Why it cannot be derived                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pics/*.png` and `fractional_steps/*`                                  | G1 compares against prototype screenshots that have never existed in this repository. M3.10 is the matrix's only `BLOCKED`, and it is blocked on an **asset**, not an opinion. The Figma work may replace this baseline entirely |
| An alert notification target and channel (open item 12)                | M6.3's promotion evidence is delivery of an alert **to a person**. A local fixture cannot supply a real channel                                                                                                                  |
| ~~A funded test wallet~~ — **supplied**; chain access                  | The delivery side holds Hoodi test funds in the ERC-8415 wallet across two accounts, so funding is not a blocker. What remains is RPC egress and an environment to run in. There is still no runtime chain evidence on any chain |
| A descriptor store and a private object store for charity holder files | CH.5 runs end to end in code; no environment has either configured, so no holder has received a file anywhere                                                                                                                    |

### 5.3 Technical work that was parked and should not have been

**Seventeen files still carry real vendor names**, three of them code contract values
(`hostRole`). `docs/DEPLOYMENT_ENVIRONMENT.md` records this as a known deviation: one-command
deletability is **not yet true**. This was listed as awaiting a decision. It is not — the client
already ruled that the deployment environment is named in one file and must be removable, so
consolidating the other sixteen is **execution**. The three contract values change behaviour and
need their tests updated with them; that is engineering caution, not a question for the client.

--- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1 | **Registry-versus-chain divergence**: which way it resolves | Determines how the M2.8 reconciliation is implemented. `PRD.md` §1.0.5 records it open |
| 2 | **Open item 6**: CH.1's 13-work first supply versus the 37 already minted | The verifier deliberately does **not** enforce the 13-work list; enforcing it would take a side |
| 3 | **`ACCEPTANCE.md` §7.8 wording** | Annotated, not rewritten. The redirect clause does not govern; the text is the client's to correct |
| 4 | **G1's visual baseline** once the Figma work lands | `pics/*.png` has never existed in this repository; M3.10 is the matrix's only `BLOCKED` |
| 5 | **Seventeen files still carrying real vendor names**, three of them code contract values (`hostRole`) | `docs/DEPLOYMENT_ENVIRONMENT.md` records this as a known deviation: one-command deletability is **not yet true** |
| 6 | **Alert notification target and channel** (open item 12) | This is what gates M6.3. Local fixtures cannot supply delivery-to-a-person evidence |

---

## 6. The last change, committed after this file was first written

This section originally described work still in the working tree. It landed in `0268f05`, and this
file was corrected rather than left stale — a handoff that reports pushed work as outstanding
invites exactly the duplication it exists to prevent. **Nothing is outstanding.**

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

Status: committed in `0268f05` with every gate green — 98 browser tests across desktop and mobile
(96 passing, 2 skipped), 106 unit tests, lint, typecheck, build, format, secret scan and chain
consistency. **This discloses; it does not fix.** M3.7 — the real catalogue replacing the fixtures —
stays `NOT-IMPLEMENTED` and this notice is not evidence toward it.

One note on running the browser suite here: this environment's Playwright build and its installed
Chromium revision do not match, so the suite was run through a throwaway config pointing at
`/opt/pw-browsers/chromium_headless_shell-1194`. That file is **not** part of the delivery and is
not in the repository. `pnpm test:e2e` is the command; it needs a matching browser install.

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
- **Do not park a technical question as a client decision.** The client does not rule on technical
  questions. Where the documents already answer one, read them and decide; where they do not,
  choose the least-expansive reversible implementation and record the reading as correctable
  (`AGENTS.md` §5). Referring it upward is not neutrality — it stops delivery and answers nothing.

## 7.1 The charity Hoodi run

[`TESTPLAN_HOODI_CHARITY.md`](TESTPLAN_HOODI_CHARITY.md) is the executable sequence for the one
thing this side cannot do: run the charity path on Hoodi. It restates `CH.1`–`CH.11` and §7.0 as
steps, says what each one proves and does not prove, and lists the stop conditions.

Two notes on it. **No CCHS or ArtCCH document is a precondition** — the test chain proves the
technical path (client ruling of 2026-09-19, `PRD.md` §7.0). And **executing it promotes nothing**:
it produces evidence, and promotion is a separate decision against the exact reviewed commit.

## 7.2 Parallel work split — whole artwork is taken

Two tracks are open at once. This section exists so neither side builds the other's work twice.

| Track                                   | Owner       | Files                                                                                                                                                          |
| --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Charity on Hoodi (`S-CH` verification)  | delivery    | `ArtFiCharityEditions.sol`, `DeployCharityEditions.s.sol`, `charity-*` web libs and components, per §7.1                                                       |
| Whole-artwork settlement (`S-WA` slice) | supervision | `WholeArtworkMarket.sol`, `WholeArtworkMarket.t.sol`, `DeployWholeArtworkMarket.s.sol`, `whole-artwork-intent.ts`, `whole-artwork-listing.tsx` and their tests |

The two do not touch the same files. Charity imports nothing from the market, and the market
imports nothing from charity.

### What the whole-artwork slice is, and what it is not

**There are two markets, and the PRD says so.** `PRD.md` §1 lists the product lines and §1.0.1
gives them as two asset models. Model A, the full artwork asset receipt, is
`Artwork → Custody → Registry → ERC-8415 asset representation → Market transfer`, one token for one
artwork. Model B, the artwork investment fund, is the line §1.0.1 states "the ERC-721 mint, vault,
and ERC-20 fractionalization requirements in §4 implement" — `ArtFiRWA` into `ArtFiVault`, out as
`FractionalToken`, traded as ERC-20 in `ArtFiMarket.sol`. §3.2.3 carries the same split into the
stage table as `S-WA` and `S-FR`. **The split is stipulated, not derived here**, and earlier drafts
of this section cited §4.2.2 for it, which is the settlement rule, not the market split.

**The gap it closes.** `ArtFiMarket` trades `IERC20` asset tokens only — model B's fractions. Model
A had no venue at all: an artwork could be registered, minted and held, and never listed or sold.

**The settlement shape is not a choice made here either.** `PRD.md` §4.2.2 (client ruling
2026-08-30) already ruled that the non-auction path settles by signature: no pull at listing time,
both sides pulled at fill time, no resting balance. `AGENTS.md` §1.1 invariant 6 states the same
boundary. Escrow is retained for auctions only, which is why `ArtFiMarket` is **not** modified.

**Model A has no token yet — a finding, not a blocker.** No ERC-8415 asset representation exists
anywhere in this repository; the only occurrences of the term are documentation and code comments.
`ArtFiRWA` is a plain ERC-721 and §1.0.1 assigns that stack to model B. So the model A venue now
exists while the model A asset does not. That costs nothing: the market deploys with no collection
allowed and settles nothing until a token manager opens one, so there is no wrong default to
inherit. Building the ERC-8415 representation is its own scope item and needs the standard, which
is not available in this environment — it is reported here, not invented.

Two readings are recorded in the contract header as **correctable** rather than settled
(`AGENTS.md` §5): that model A currently has no token of its own, and that the asset leg is written
against the minimal ERC-721 surface (`ownerOf`, `isApprovedForAll`, `safeTransferFrom`) with the
collection as a parameter rather than a constant. If the ERC-8415 representation exposes that
surface this works unchanged; if it does not, only the transfer leg needs an adapter — the intent,
the signature scheme, the revocation model and the UI do not depend on the choice.

**A conflict worth recording, not acting on unasked.** That same ruling says `_pullExact` is
removed from the fixed-price path. In `ArtFiMarket._createListing` it is still called for
`FixedPrice` as well as `Auction`, and `buyFixed` still credits the seller into `credits[...]`. So
the fractions fixed-price path escrows and holds a resting balance, which §4.2.2 forbids. That is a
**finding against `ArtFiMarket`, separate from this slice** — baseline `PRD.md` §4.2.2, evidence
`ArtFiMarket.sol` `_createListing` and `buyFixed`. It is not fixed here, because changing the
fractions market is its own reviewable change with its own test surface. Whoever takes it should
know the ruling's two stated consequences are the acceptance test: the fixed-price path holds
nothing at rest, and one seller may keep the same tokens listed in several places at once.

**The wire format is locked across the two implementations.** One fixed intent, domain and digest
(`0x29a4bedd…`) is asserted in both `WholeArtworkMarket.t.sol::testDigestMatchesTheBrowserSigner`
and `whole-artwork-intent.test.ts`. A renamed field, a reordered struct or a changed domain string
fails a test on both sides rather than producing signatures the market rejects at fill time. Do not
"fix" a drift by editing one side.

### What it still needs — and who supplies it

Nothing in this list is a blocker on anything else, and none of it is a client decision.

1. **Deployment on Hoodi.** `DeployWholeArtworkMarket.s.sol` is Hoodi-gated and reads
   `ARTFI_ADMIN`, `ARTFI_PAUSER`, `ARTFI_TOKEN_MANAGER`. It deploys with no collection and no
   payment token allowed, so a fresh deployment can settle nothing until the token manager opens
   one. This side has no chain egress; the delivery side has the funded wallets.
2. **`NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS`**, plus the artwork's own contract address
   and token id reaching the asset page. Until both are present the panel renders its
   unconfigured branch by design and offers no control.
3. **A real catalogue.** `lib/catalog.ts` is still six invented artworks with no on-chain identity
   (M3.7). Every asset page therefore shows the unconfigured branch today.
4. **A model A token to open the market over**, per the finding above. Pointing it at `ArtFiRWA`
   would open the model A venue over model B's asset; the allowlist exists so that decision is
   explicit rather than a default.

Items 2, 3 and 4 are why this is **not** a stage handover: no user can yet carry the function out end
to end, so `PRD.md` §3.2.1 is not met and nothing in `STATUS.md` moves. The path is built, tested
and counted, which §3.2.6 is explicit is not the same as opened.

### One retired claim removed from the UI

The asset page read "Minting unlocks in Stage 2" and "Trading unlocks in Stage 4". That ladder is
`docs/ROADMAP.md`, priority 6 under `AGENTS.md` §1; the strings `Stage 1`–`Stage 4` appear nowhere
in `PRD.md`, and §3.2.6 states that stage order is not a gate. Adding a signing surface also made
the neighbouring "never requests a transaction or signature" false on that page. The fractional
page keeps an accurate version: the fraction market exists on chain and no screen reaches it
(M3.1). `whole-artwork-listing.spec.ts` fails if either phrasing returns.

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
