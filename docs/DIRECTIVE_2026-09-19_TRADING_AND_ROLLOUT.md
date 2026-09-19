# Client directive — trading model and phased business rollout

| Field     | Value                                                                     |
| --------- | ------------------------------------------------------------------------- |
| Issued    | 2026-09-19                                                                |
| Issuer    | Client (ArtCCH)                                                           |
| Authority | Explicit later client ruling (`AGENTS.md` §1, priority 2)                 |
| Scope     | Trading model, rollout sequencing, operations topology, delivery standard |
| Applies   | `GiraffeTechnology/ArtFi`, all branches                                   |

---

## 0. Partner naming

This directive uses the neutral placeholders required by #110 §4. The client's own message named
real vendors; they are **not** reproduced here.

| Placeholder          | Means                                                           |
| -------------------- | --------------------------------------------------------------- |
| `<CLOUD_PROVIDER_A>` | The domestic cloud holding delivery and the database            |
| `<CLOUD_PROVIDER_B>` | The cloud hosting the SIN execution zone for on-chain operation |
| `<LLM_PROVIDER_A>`   | The model API the operations agent calls                        |
| `<REGISTRY_CHAIN_A>` | The third-party registry chain (a cultural-heritage registry)   |

`<LLM_PROVIDER_A>` is **explicitly swappable**. The client's words: ArtFi is not in that vendor's
ecosystem and the model may be changed at any time. No design may assume one model vendor.

### 0.1 Two categories, two rules

A later ruling the same day: **the deployment environment may be written to GitHub, and must be
removable at any time.** This repository is **private** — it is on GitHub so external auditors and
VC auditors can read it, not for public distribution.

That permission covers infrastructure, not relationships:

| Category               | Example                 | Naming                                                     |
| ---------------------- | ----------------------- | ---------------------------------------------------------- |
| Deployment environment | Which cloud runs the DB | May be named, in `docs/DEPLOYMENT_ENVIRONMENT.md` **only** |
| Partner / ecosystem    | `<REGISTRY_CHAIN_A>`    | **Placeholder always** (#110 §4, unchanged)                |

The distinction is the reason #110 §4 exists: a deployment vendor is infrastructure ArtFi rents; a
partner is a relationship ArtFi claims. Naming the second implies an endorsement that may not exist.

**Deletability is the operative constraint.** The bindings live in one file so that removing them is
`git rm docs/DEPLOYMENT_ENVIRONMENT.md` and nothing else. Governing documents keep using
placeholders and roles, so they still read correctly once the file is gone. A vendor name written
into a governing document, a code path or a contract value breaks this and turns deletion into a
repository-wide edit with behaviour risk.

---

## 1. Trading model

**All trading is available both on ArtFi and on OpenSea. ArtFi is primary.**

**OpenSea and other third-party venues are an early-stage state.** The client's stated ambition is
ArtFi itself as an ERC-8415-standard commercial product — an **artwork RWA market**.

This supersedes the ruling of earlier the same day, which made OpenSea the sole venue for
whole-artwork trading and ArtFi a mirror only. `PRD.md` §0 requires the latest explicit client
requirement to control and the conflict to be recorded rather than silently resolved, so the
superseded position is written down in `PRD.md` §1 rather than deleted.

What does **not** change: the intermediary invariant of 2026-08-30. On the ArtFi side trading
settles by signature. **ArtFi never custodies, never acts as counterparty, and never moves a
user's asset without that user's signature for that fill.** Being a venue is not permission to hold.

### 1.1 Two phases per product line

Third-party venues are the **early-stage state**. ArtFi has trading of its own, opened per product
line by the rollout sequence in §2. **Until a line opens on ArtFi, ArtFi does mirroring only for
that line**; once it opens, ArtFi also trades, settled by signature.

The original PRD (`d754c6b`) describes that first phase and nothing more — its J-05 and
`MARKET-004` are the mirror-only phase stated correctly, **not a superseded position**. There is no
conflict to resolve between it and this directive.

**Mirror-only describes what is switched on, never what may be written.** The ArtFi trading surface
for an unopened line is still built, tested and counted, and the mirror boundary is identical in
both phases: ArtFi never creates, signs, matches, custodies, fulfils or settles on a venue's behalf.

Because mirroring _is_ attributed data plus a link out, the deep link required by `PRD.md` §4.8
XM.4 stands. `ACCEPTANCE.md` §7.8 listed an external-marketplace redirect in the public UI as an
audit failure; an item that forbids what a requirement mandates cannot be an audit condition, and
under the authority order in `AGENTS.md` §1 that file may not contradict a higher source. **That one
item is removed.** Every other exposure listed in §7.8 is untouched and still fails an audit.

### 1.2 Correction recorded

This directive first read 以本地为主 as "ArtFi is the terminus". The client corrected it:
**primary**, with third-party venues an early-stage state on the way to ArtFi's own market. The
earlier wording is replaced, and the correction recorded rather than quietly overwritten.

**No engineering consequence is drawn from the direction.** Whether, when or how third-party venue
support is reduced is a **client decision** and is not made here. Until such a ruling:

- the external-market mirror (`PRD.md` §4.8, XM.1–XM.6) stays built, tested and counted as it is;
- the charity rollout order — OpenSea first, then ArtFi — is unchanged;
- the mirror boundary is unchanged: ArtFi never creates, signs, matches, custodies, fulfils or
  settles on a third-party venue's behalf;
- **no gate, status value or delivery condition follows from it.**

Product direction is not scope. Turning "ArtFi is primary" into a requirement to build or retire
anything would be agent-authored scope (`AGENTS.md` §0).

---

## 1.3 Holder authority

Three parts, read together.

**Registries of record are a class, not a company.** ArtCCH's registry is **part of its own-account
business**, and its nature is **the same as a third-party registry chain** such as a
cultural-heritage registry (`<REGISTRY_CHAIN_A>`). Equal standing, one class. ArtCCH's is the one
that originates self-operated registrations.

**For a registry-backed asset, the registry of record is the holder authority**, and the on-chain
token is its projection:

```text
ArtCCH registry (off-chain)  →  <REGISTRY_CHAIN_A>  →  ERC-8415 token  →  ArtFi / OpenSea
```

**Structurally, ArtFi treats ArtCCH as a third party.** The authority belongs to the **registrar
role**, not to ArtCCH as an operator. Any other registrar in the same role has the same authority
and travels the same code paths. **ArtFi is a consumer of registries; it operates none of them.**

### 1.3.1 What ArtCCH's registry records

Physical parameters of the artwork, the **holder**, and **provenance**.

### 1.3.2 This does not reopen the two-roles ruling

§1.4.1 of the 2026-08-30 directive stands: no seller allowlist, no role restricting who may list, no
administrative interface able to move ArtCCH's holdings, matching blind to seller identity, and the
self-operated / intermediary distinction never branching the settlement path.

**Being the registrar of record for an asset is not a trading privilege over it.**

### 1.3.3 What did not change

§1.4 of the 2026-08-30 directive says Redis and MySQL are not the ownership authority, the chain is.
That is about **ArtFi's own projection tables** and it stands. A registry of record is not an ArtFi
database. Three records, distinct standing: the registry is authority for holdership, the chain is
its projection and the settlement record, and ArtFi's projection is authoritative for nothing.

### 1.3.4 Consequence, resolved

A registry-versus-chain divergence looked like a case needing a ruling. It is not: the assignment
above already gives each record a **different question** — the registry answers who holds it, the
chain answers what settled and when — so there is no tie to break. On divergence ArtFi reports both
and substitutes neither for the other, and never answers either from its own projection. Written
out in `PRD.md` §1.0.5.

---

## 2. Phased business rollout

**This is a business rollout sequence, not a promotion gate.** It adds nothing to G1–G4 in
`ACCEPTANCE.md`, creates no new status value, and blocks no requirement. A track that has not
opened is still built, tested and counted in `STATUS.md`.

> Recorded deliberately: an earlier agent-authored "gray gate" (`G0`) was dismantled by #91 and #94
> precisely because it invented a gate nobody asked for. This section must not become that. It
> describes **when a built capability is switched on for business**, not when engineering may
> proceed.

### 2.1 Charity NFT editions

Rollout order: **OpenSea first, then ArtFi**, opened in stages.

**Delivery must be launch-ready at any time.** The staging is a business decision about when to
open; it is not permission for the build to be unfinished. At any point in the sequence the charity
module must be in a state that could go live.

### 2.2 Whole artwork

Opens only once the following exist:

- an **Oracle** call path;
- an **ERC-8415 wallet**;
- off-chain registration at ArtCCH projected to a **third-party registry chain**
  (`<REGISTRY_CHAIN_A>`).

```text
Artwork → ArtCCH off-chain registration → <REGISTRY_CHAIN_A> → ArtFi / OpenSea
```

### 2.3 Fractionalization

Opens **only after exempt-market compliance is complete.** Compliance is client-side and legal; it
is not an engineering deliverable and must not be recorded as an engineering blocker.

### 2.4 Operations

| Concern               | Where                                              |
| --------------------- | -------------------------------------------------- |
| Delivery and database | `<CLOUD_PROVIDER_A>`                               |
| On-chain operation    | The **SIN execution zone** on `<CLOUD_PROVIDER_B>` |
| Availability          | An **operations agent** maintaining 24/7 service   |
| Model access          | `<LLM_PROVIDER_A>`, **swappable at any time**      |

This keeps the deployment topology ruling of 2026-09-05 (#74): off-chain data stays domestic; only
public-chain operation runs in the SIN execution zone.

**The model boundary is a design constraint.** Because `<LLM_PROVIDER_A>` may be replaced at any
time, the operations agent must reach it through a replaceable interface. No prompt, schema or
control path may depend on one vendor's behaviour, and model output stays advisory — transaction
authority comes from deterministic policy, per `AGENTS.md` §6.

---

## 3. Delivery standard

**Two rulings, both binding.**

**1. ArtFi is delivered in stages, not as one complete end-state handover.** The PRD must state the
stages plainly. Only the complete RWA market — ArtFi as an ERC-8415-standard artwork RWA market —
is handed over whole; everything before it is a stage.

**2. Every delivery is measured by what is visible and operable in the UI.** A stage is delivered
when a user in its intended role can carry out its function from the ArtFi UI, desktop and mobile,
with G1 visual sign-off and evidence per `ACCEPTANCE.md` §3. A working endpoint, a deployed
contract, a green test or a generated client that **no screen reaches** is progress, not a stage
handover. **The screen is the deliverable.**

Recorded in `PRD.md` §3.2, with the stage table in §3.2.3 and the evidence rule in
`ACCEPTANCE.md` §6.2.

### 3.1 Visual design is a separate, client-side track

Same date, same ruling: **the UI is being redone in Figma, and the delivered version is verified on
functional delivery.**

"UI-visible" therefore means the function is **operable from a screen**, not that the screen is
final and not that its visual design is being accepted. A pending redesign neither blocks nor
invalidates a stage delivery, and delivery builds should prefer shared classes and semantic markup
so a re-skin costs stylesheet work rather than rebuilt components.

Nothing functional relaxes: fail-closed behaviour, the absent preview, the rights disclosure and
the verification gates are function, not styling.

**Recorded, not decided.** G1 tests parity against `pics/*.png` and `fractional_steps/*`, which have
never existed in the repository and are the single `BLOCKED` item. If the Figma work replaces that
baseline, it becomes G1's reference. **The block is a missing artefact, not a pending decision** —
no reading of any document produces a screenshot. Nothing else waits on it.

### 3.2 The production version is assembled once, at the end

Same date: **the production version is done last, in one piece.** Production assembly is a
client-scheduled step, not a per-stage obligation.

A stage delivers against the test chain and carries no production build, production deployment,
production-grade visual design or go-live packaging; it is not incomplete for lacking them.
`ACCEPTANCE.md` §6 items 7–10 stay with the complete market (`S-MKT`). **No stage may be blocked on
production readiness, and no agent may pull production work forward to prepare for it.**

**Building is not assembling.** An unopened or not-yet-productionised track is still built, tested
and counted — `M6` operations code is written when its requirements say so.

Recorded in `PRD.md` §3.2.5.

### 3.3 Boundaries

This is a delivery standard, not new scope. It **does not**:

- add or change a promotion gate — G1–G4 are unchanged;
- add a status value — item status stays the six values in `ACCEPTANCE.md` §2;
- create a requirement, a scope item or a `STATUS.md` row — the stage table groups requirements
  that already exist in `PRD.md` §4;
- make mainnet a condition of a stage — `ACCEPTANCE.md` §6 items 7–10 remain the terminus for the
  complete market, not for each stage;
- set a build order. Stage **opening** follows §2 of this directive; **engineering does not wait**
  on it, and a track that has not opened is still built, tested, counted and kept launch-ready.

---

## 4. What this directive does not change

- No code, contract, test or deployment tooling is modified by it.
- No requirement status or count in `docs/STATUS.md` moves.
- The promotion gates G1–G4 are unchanged, and no new gate is created.
- The intermediary invariant stands: signature settlement, no custody, no counterparty role.
- The test chain remains Hoodi `560048`; the production chain remains undecided.
- Partner placeholders remain mandatory (#110 §4).
