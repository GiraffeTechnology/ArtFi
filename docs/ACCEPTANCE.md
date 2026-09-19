# ArtCCH:ArtFi — Delivery and Acceptance Standard

Version: 2026-08-30
Status: Acceptance baseline
Companion to: `PRD.md` (what is built), `STATUS.md` (where it stands)
Amended by: `DIRECTIVE_2026-08-30_DELIVERY.md` §1.1 (G3 split), §1.3 (measurement),
§1.4 and §1.4.1 (intermediary, two roles)

---

## 1. Purpose

This document defines how a requirement in `PRD.md` is proven, how the build is promoted from
testnet to mainnet, and when the project may be called delivered. It defines **process only**.
It introduces no requirement and removes none — a rule here that changes what gets built is a
defect in this document.

---

## 2. Status vocabulary

Six values. Only these may be used.

| Status                     | Meaning                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `VERIFIED`                 | Requirement and acceptance evidence exist on the exact reviewed commit and environment.    |
| `IMPLEMENTED-NOT-VERIFIED` | Code exists; one or more required tests or runtime proofs are missing.                     |
| `PENDING-GATE`             | **In scope and scheduled.** Complete or ready, awaiting a named upstream gate (see §4).    |
| `BLOCKED`                  | An unplanned external, security, legal, funding or environment obstacle prevents progress. |
| `NOT-IMPLEMENTED`          | Required behavior is absent.                                                               |
| `OUT-OF-SCOPE`             | Excluded by the approved scope in `PRD.md` §8, or by a signed scope change.                |

`PENDING-GATE` vs `BLOCKED`: a gate is planned and its clearing condition is in the schedule
(mainnet deploy pending audit sign-off). A block is unplanned and needs escalation (audit firm
unavailable). Mainnet deployment before P5 is `PENDING-GATE` — never `BLOCKED`, never
`OUT-OF-SCOPE`.

`OUT-OF-SCOPE` means _excluded by contract_. It must never be used for work that is merely
deferred, unfinished, or awaiting a prerequisite. Using it that way silently deletes paid scope.

The words "complete", "delivered", "passed" and "production-ready" are reserved: they may be used
only when every applicable acceptance item is `VERIFIED` on the same commit.

---

## 3. Evidence rules

The following do **not** constitute evidence of delivery:

- a PRD statement, screenshot, mockup or design file;
- source code existing only in a local working directory;
- a test result from a different commit, branch, chain or contract;
- a simulated transaction without a confirmed receipt;
- a public page that renders but cannot execute its represented function;
- mock or fixture data presented as live;
- an operator statement without reproducible evidence.

Every claim cites a file path, test name, CI run, or transaction hash and receipt. Where evidence
is unavailable, the status is recorded — never inferred, substituted or invented.

---

## 4. Promotion gates

Sequential. Each gate's exit condition is the next stage's authorization. Clearing a gate requires
no separate approval cycle beyond the sign-offs named below.

### G1 — Prototype parity preserved (continuous)

Class A surfaces (`PRD.md` §2.1) still work. Regression suite green. Desktop and mobile
screenshots beside the corresponding `pics/*.png` and `fractional_steps/*` images, with human
sign-off, for any surface the delivery touched.

**Parity is a floor, not a target.** A surface that matches the prototype but is still backed by
mock data fails G1 if it appears in Class B.

### G2 — Functional completion on testnet

Every Class B and Class C requirement `VERIFIED` on Hoodi (560048), on one integrated commit:

1. Chain ID and genesis attested through the approved SIN boundary.
2. Wallet balances and nonces read; source commit, init-code/runtime hashes, manifest and signer
   policy verified; every transaction estimated and simulated before broadcast.
3. Contract suite deployed; auction, revenue distribution, governance and multi-sig exercised
   end to end with receipts.
4. Atomic batch executed on the Hoodi AI test payload (`PRD.md` §7.0): every token ID minted,
   supply and issuer balance exact, aggregate correct, and an excluded item proven hard-rejected.
   The Sepolia 37-work batch is not re-executed; it stays frozen as the historical record.
5. A separate isolated test stack deployed, its units minted, approved quantity transferred
   issuer → buyer, buyer wallet control and DAO membership verified.
6. Proposal / vote / queue / timelock execution tested for every threshold class
   (10% / >50% / >66.6667% / >80%).
7. Order lifecycle proven: create, amend, cancel, partial fill, match, settle, and position
   projection reconciled against chain state.
8. Auth negative tests: unauthenticated trade rejected, role escalation rejected, browser-supplied
   headers alone cannot grant admin access.
9. A01–A38 compliant previews available with hash mapping; no preview URL exposes a master.
10. Failure paths exercised: RPC unavailable, insufficient gas, rejected signature, translation
    failure, external-marketplace unavailability.
11. Transaction hashes, receipts, blocks, events and balances recorded for every runtime item.

**The intermediary invariant is proven as part of this gate** (`PRD.md` §4.2), by a rejection case
for each of:

- a settlement carrying no signature at all;
- a settlement carrying the seller's signature but not the buyer's;
- a settlement carrying the buyer's signature but not the seller's;
- a settlement whose signature does not match the terms it claims to authorize;
- a fill against an intent the signer has revoked;
- a fill exceeding the intent's authorized quantity, or replaying a fully consumed intent;
- an administrative call attempting to move, freeze or reassign a user's assets;
- a matching decision that differs when the seller is ArtCCH rather than a third party.

Each counterparty is proven separately: a rejection case that only covers a wholly unsigned
settlement would let a seller-only or buyer-only fill pass while moving the unsigned party's
holdings. Seller-identity blindness is proven by replaying the order log with ArtCCH's and a third
party's addresses exchanged and showing the same match sequence (`PRD.md` §4.2.1). The position
projection is additionally proven never to diverge from chain state without reporting the
divergence.

Funding or signer availability may be sequenced after non-funded tests but never used to mark a
runtime item passed.

### G3-A — Simulated audit passed (blocks acceptance)

Internal security review and penetration test complete; all high-severity and critical findings
remediated; **each finding re-verified by a test that failed before the fix and passes after it**.
A finding recorded in prose without such a test does not count as closed.

The simulated audit is conducted against a frozen commit SHA and produces the same artifacts a
firm would issue: scope statement, per-contract threat model, findings graded
`Critical / High / Medium / Low / Info`, remediation record, and re-verification evidence. It is
structured so an external firm can diff its own findings against it.

Threat modelling covers, at minimum: reentrancy, access control, pause bypass, arithmetic and
rounding boundaries, fee-on-transfer tokens, price manipulation, snapshot double-voting, and
timelock bypass.

### G3-B — Third-party audit passed (blocks mainnet only)

Third-party audit report issued by a recognized firm; all high-severity and critical findings
remediated; remediation re-verified by the auditor or by a test proving the finding is closed.
Report and remediation record are delivery artifacts.

**G3-B does not block development or acceptance.** It is the last work before go-live. Its status
is `PENDING-GATE` until it runs — never `BLOCKED`, never `OUT-OF-SCOPE`, and its budget remains on
the books.

**Contracts freeze at G3-A, not at G3-B.** The suite is frozen once M1 closes; G2 runtime evidence
is gathered against that bytecode, and G3-B audits the same bytecode. Deferring the external audit
while contracts keep changing would let one late finding invalidate the contract suite and the
entire G2 evidence set together, because §3 excludes evidence from a different commit or contract.

### G4 — Mainnet authorization

**G1 + G2 + G3-A green on one commit constitutes acceptance.**

**Acceptance + G3-B constitutes authorization to deploy to mainnet.** No further approval gate
exists. Deployment proceeds under the managed release process with multi-sig control of privileged
operations.

---

## 5. CI acceptance

One GitHub CI run on the exact integrated delivery commit. Mandatory jobs:

- frozen dependency install and lockfile validation;
- Prettier, ESLint, and full TypeScript type checks;
- Web, wallet-extension and API-client unit tests;
- Next.js Linux production build;
- desktop and mobile Playwright and Axe tests;
- Go format, vet, unit and race tests;
- MySQL 8.4 forward migrations from empty, integration tests, logical backup, restore into an
  isolated database, schema and seed verification, reverse migrations;
- Foundry format, build, high-severity lint, unit, fuzz, invariant and integration tests;
- deployment-tooling, mint-package, charity-edition, 37-work metadata and release verifiers;
- secret, private-key, raw-signed-transaction and prohibited plaintext-IP scans.

CI is accepted only when all required jobs are green on the delivery commit. A green historical
commit is not evidence for a later candidate.

---

## 6. Definition of delivered

ArtFi is delivered when all of the following hold:

1. Every in-scope requirement in `PRD.md` is `VERIFIED`, or `OUT-OF-SCOPE` under a signed scope
   change.
2. G1 human visual sign-off complete for every touched surface, desktop and mobile.
3. G2 complete: all six modules functionally verified on testnet from one commit.
4. G3-A complete: simulated audit passed, every finding closed by a re-verification test.
   G3-B is `PENDING-GATE` until item 7.
5. The candidate is committed to an authoritative branch with no secret material; tested,
   deployed and documented commits are identical.
6. GitHub CI green on that commit; PR approved and merged.
7. **Mainnet contracts deployed and verified on the block explorer; address manifest published.**
8. **Production deployment complete and publicly smoke-tested** — represented functions execute;
   HTTP 200 is insufficient.
9. **System stable for 48 continuous hours** with monitoring and alerting active.
10. Operator documentation and runbooks handed over.

Items 7–9 are the delivery terminus (Gantt P5). A delivery that stops at testnet has completed
G2, not the project. G3-B runs immediately before item 7 and gates it.

### 6.1 Measuring progress

Person-days are not a unit of progress. Every requirement in `PRD.md` §4, §5 and §7, and every
Class B and Class C surface in §2.2 and §2.3, is itemized in `STATUS.md` and carries one of the six
values in §2. Progress is reported as a count of `VERIFIED` items against the total — never as a
percentage of elapsed effort, and never in person-days.

`STATUS.md` is updated on every delivery commit. A commit that changes source without updating it
is incomplete.

### 6.2 Stage delivery — UI-visible evidence

Client ruling of 2026-09-19 (`DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md` §3). §6 above defines
when **the complete RWA market** is delivered. This subsection defines the evidence for **one
stage** of `PRD.md` §3.2.3.

A stage is delivered when, for every requirement in that stage:

1. a user in the stage's intended role can carry out the function **from the ArtFi UI**;
2. the surface has G1 human visual sign-off, desktop and mobile (§4, G1);
3. the evidence rules of §3 are satisfied for each item.

**A requirement no screen reaches is not delivered**, whatever its implementation state — a working
endpoint, a deployed contract, a passing test or a generated client is `IMPLEMENTED-NOT-VERIFIED`,
not a stage handover. Fixtures presented as live behaviour fail this outright (§3).

This adds no gate and no status value. G1–G4 and the six values of §2 are unchanged, and items 7–10
of §6 remain the terminus for the complete market only — **a stage does not require mainnet**.

---

## 7. Audit instructions (human or agent reviewer)

1. Audit an exact commit SHA, never an uncommitted working directory.
2. Report every requirement using one of the six values in §2.
3. Cite file paths, test names, CI run links, and transaction hashes with receipts.
4. **Verify scope coverage first.** For each of the six modules in `PRD.md` §3, confirm
   requirements exist and are traceable. A module with no requirements is an audit failure, not
   an empty section.
5. Fail the audit if a Class B surface (`PRD.md` §2.2) is still backed by mock, static or fixture
   data while presented as functional.
6. Fail the audit if a Class A surface regressed without approval.
7. Fail the audit if local, mock or historical evidence is described as current runtime delivery.
8. Fail the audit if any A01–A38 compliant preview is missing, or if the public UI exposes an
   external-marketplace redirect, an unwatermarked master, a master download path, a private key,
   a server credential, a raw signed transaction, a prohibited IP or internal topology.

   > **The redirect clause does not govern, as of the client ruling of 2026-09-19.** That ruling
   > makes third-party venues the early-stage state and requires ArtFi to do **mirroring only**
   > until a product line opens on ArtFi — and mirroring is attributed data plus an HTTPS link out
   > to the venue (`PRD.md` §4.8, XM.4, carrying the original `MARKET-004`). This file is priority 4
   > in `AGENTS.md` §1: it may record a higher source, never contradict one. **Every other item in
   > this clause stands unchanged** and still fails an audit. The wording above is left as written
   > rather than edited, because correcting it is the client's call, not an agent's.

9. Fail the audit if A02 enters the formal 37-work set or any mainnet manifest.
10. Fail the audit if tested, deployed and documented commits differ.
11. Fail the audit if a non-mainnet-only requirement is deferred without completed test evidence.
12. **Fail the audit if in-scope work is marked `OUT-OF-SCOPE` without a signed scope change**, or
    if a scheduled item awaiting a gate is recorded as `BLOCKED` or `OUT-OF-SCOPE` rather than
    `PENDING-GATE`.
13. Produce a gap table by module, counted in `STATUS.md` items and their §2 status values. Do not
    express the gap in person-days.
14. Fail the audit if `STATUS.md` carries unfilled placeholders, or if source changed since its
    last update.
15. Fail the audit if the configured test chain is not consistent across every layer that names
    it — Solidity, shell tooling, TypeScript, Go, SQL constraints and the environment example. A
    directive that the tooling silently refuses to execute is the failure mode this rule exists to
    catch.
16. **Fail the audit if any charity-edition master is reachable.** A preview URL, public metadata
    field, website download, or any browser-delivered object that resolves to an unwatermarked
    master is a failure, as is a charity master present in public storage (`PRD.md` §4.7 CH.6,
    CH.7). A manifest that _declares_ the correct posture is not evidence that the runtime enforces
    it; the check is against what the running system actually serves.
17. **Fail the audit if the charity holder benefit is presented as available without the runtime
    behind it** — ownership verification followed by watermarked delivery (`PRD.md` §4.7 CH.5) — or
    if an edition is displayed or offered without the no-rights disclosure required by CH.8.
