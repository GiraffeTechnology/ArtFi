# ArtCCH:ArtFi — Product Requirements Document

Version: 2026-08-30
Status: Draft for approval
Repository: `GiraffeTechnology/ArtFi`
Supersedes: `PRD_AND_DELIVERY_STANDARD.md`
Amended by: `DIRECTIVE_2026-08-24_HOODI.md` (test chain), `DIRECTIVE_2026-08-30_DELIVERY.md` §1.2.1
(Hoodi test payload), `DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md` (§1 product definition),
`DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md` (§1 trading model and rollout, §3.2 staged delivery)

---

## 0. Document set and authority

This PRD defines **what is built**. It is one of three documents; do not merge them.

| Document        | Answers                                      | Changes when            |
| --------------- | -------------------------------------------- | ----------------------- |
| `PRD.md`        | What must exist and how it must behave       | Scope change (approved) |
| `ACCEPTANCE.md` | What proves it exists and how it is promoted | Process change          |
| `STATUS.md`     | Where each item stands right now             | Every delivery commit   |

Scope authority is the signed quotation (six modules). Its commercial terms are held outside this
repository and are not reproduced here; progress is counted in items, never in effort
(`ACCEPTANCE.md` §6.1). Functional authority is the inherited prototype documentation.
Where these conflict, the latest explicit written requirement from the client controls, and the
conflict is recorded — never silently resolved.

---

## 1. Product definition

Amended by `DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md`.

ArtCCH:ArtFi is a commercial digital art and Real-World-Asset (RWA) platform. **It is a commercial
application, not a demo**, and it must not be treated as an ERC-8415 demo application.

It supports three product lines. **All trading is available both on ArtFi and on OpenSea, and ArtFi
is primary** (client ruling 2026-09-19,
[`DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md)).
**OpenSea and other third-party venues are an early-stage state.** The target is ArtFi itself as an
ERC-8415-standard commercial product — an **artwork RWA market**.

| #   | Product line                    | What is traded                          | Venues                               | Opens when                                                                                                  |
| --- | ------------------------------- | --------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | **ERC-8415 asset products**     | One whole artwork, as a custody receipt | ArtFi + OpenSea                      | Oracle path, ERC-8415 wallet, and ArtCCH off-chain registration projected to `<REGISTRY_CHAIN_A>` all exist |
| 2   | **Artwork investment products** | Fund tokens / fractions of one artwork  | ArtFi + OpenSea                      | Exempt-market compliance is complete (client-side, legal)                                                   |
| 3   | **Charity NFT editions**        | Fixed 100-unit ERC-1155 editions        | OpenSea first, then ArtFi, in stages | Staged — **and delivery must be launch-ready at any point in the sequence**                                 |

**On the ArtFi side, trading settles by signature.** ArtFi never custodies, never acts as
counterparty, and never moves a user's asset without that user's signature for that fill (ruling of
2026-08-30, §4.2). **Being a venue is not permission to hold.** On the OpenSea side ArtFi mirrors
attributed data and links out; execution there completes on OpenSea.

> **Conflict recorded, resolved by the later ruling (§0).** Earlier on 2026-09-19 the ruling was
> that whole-artwork trading happens **only** on OpenSea and ArtFi is a mirror only. The later
> ruling the same day makes both venues live with ArtFi primary. §0 requires the latest explicit
> client requirement to control and the conflict to be recorded, so the superseded position is
> written here rather than deleted. The original PRD (`d754c6b`) matched the superseded position —
> its J-05 said execution leaves ArtFi — and it is now history on this point.

> **Correction recorded.** This document first read 以本地为主 as "terminus". The client corrected
> it: **primary**, with third-party venues an early-stage state. The earlier wording is replaced
> rather than defended.

**What "ArtFi is primary" means, and what it does not.**

**Means.** ArtFi is the product being built, not a front end for someone else's market. Third-party
venues are how the market is reached while ArtFi's own market matures; the destination is an
ERC-8415-standard artwork RWA market operated as ArtFi.

**Does not mean.** No engineering consequence is drawn from this here. **Whether, when, or how
third-party venue support is reduced is a client decision** and is not decided in this document.
Until such a ruling:

- the external-market mirror (§4.8, XM.1–XM.6) is built, tested and counted exactly as it is now;
- the charity rollout order — OpenSea first, then ArtFi — is unchanged;
- the mirror boundary is unchanged: ArtFi never creates, signs, matches, custodies, fulfils or
  settles on a third-party venue's behalf;
- **no gate, status value or delivery condition follows from this paragraph.**

It is a statement of product direction, recorded under §0 as a client ruling. It is not a scope
change.

### 1.0.0 Phased business rollout — not a gate

The "opens when" column above is a **business rollout sequence**. It adds nothing to the G1–G4
promotion gates, creates no status value, and blocks no requirement. **A track that has not opened
is still built, tested and counted in `STATUS.md`.**

This is stated explicitly because an agent-authored "gray gate" (`G0`) was dismantled by #91 and
#94 for inventing a gate nobody asked for. This section describes when a built capability is
switched on for business, never when engineering may proceed.

### 1.0.1 Asset models

**A — Full artwork asset receipt.** Individual artwork ownership representation and transfer.

```text
Artwork → Custody → Registry → ERC-8415 asset representation → Market transfer
```

A token may represent one specific artwork custody certificate.

**B — Artwork investment fund.** An asset-specific investment product.

```text
Artwork → Single-asset fund → Fund token → DAO governance
```

The fund token represents investor participation. Each artwork may form an independent investment
product with tokenized participation and asset-specific governance. This is the model the ERC-721
mint, vault, and ERC-20 fractionalization requirements in §4 implement.

### 1.0.2 Governance authority

Governance authority depends on the product model:

- **fund products** — fund token holders participate in governance;
- **direct artwork receipt products** — governance follows the defined asset authority model.

**Token possession alone does not define governance rights unless the asset model specifies it.**

### 1.0.3 ERC-8415 and charity boundaries

ERC-8415 applies to asset identity, registry synchronization, ownership-related workflows, and asset
lifecycle management.

Charity NFT editions are an independent business module for cultural and philanthropic purposes.
They are **not** required to follow the ERC-8415 asset model and must not be forced into it. Their
requirements in §4 and §7 stand on their own.

### 1.0.4 Engagement shape

**This engagement is not a greenfield build.** A working prototype/MVP already exists and is
deployed. This engagement converts that prototype into a commercially operable product: real
backends behind the existing screens, real order flow, real governance, real money, on mainnet.

### 1.0.5 Holder authority

Client ruling of 2026-09-19, in three parts that must be read together.

**1. Registries of record are a class, not a company.** ArtCCH's registry is **part of its
own-account business**, and its nature is **the same as a third-party registry chain** such as a
cultural-heritage registry (`<REGISTRY_CHAIN_A>`). They are members of one class with equal
standing. ArtCCH's is simply the one that originates self-operated registrations.

**2. For a registry-backed asset, the registry of record is the holder authority.** The on-chain
token is its projection — the ERC-8415 shape already described in §1:

```text
ArtCCH registry (off-chain)  →  <REGISTRY_CHAIN_A>  →  ERC-8415 token  →  ArtFi / OpenSea
   record of record               peer registry          projection          venues
```

**3. Structurally, ArtFi treats ArtCCH as a third party.** The authority belongs to the **registrar
role**, not to ArtCCH as an operator, and ArtFi grants it no standing in code. Any other registrar
in the same role has the same authority and travels the same paths. **ArtFi is a consumer of
registries; it operates none of them.**

#### What ArtCCH's registry records

| Field               | Meaning                                    |
| ------------------- | ------------------------------------------ |
| Physical parameters | The artwork as a physical object           |
| Holder              | Who holds it — the authoritative statement |
| Provenance          | The ownership and custody history          |

#### This does not reopen the two-roles ruling

`DIRECTIVE_2026-08-30_DELIVERY.md` §1.4.1 stands unchanged:

- **no privileged path** — no seller allowlist, no role restricting who may list, and no
  administrative interface able to move ArtCCH's holdings, exactly as none may move a customer's;
- **matching is blind to seller identity** — ArtCCH's own orders receive no ordering, latency,
  visibility or fee advantage, and the replayable order log is what proves it;
- **disclosure, not privilege** — a listing discloses whether the seller is ArtCCH, and the
  self-operated / intermediary distinction is visible to users and accounting but **never branches
  the settlement path**.

Being the registrar of record for an asset is not a trading privilege over it.

#### What did not change

`DIRECTIVE_2026-08-30_DELIVERY.md` §1.4 says **"Redis and MySQL are not the ownership authority; the
chain is"**. That is about **ArtFi's own projection tables**, and it stands: ArtFi's position
projection is read-only, asserts no claim on anyone's property, and is never authoritative for
anything.

The ruling above names a different record. A registry of record is **not an ArtFi database**. Three
records now exist, with distinct standing:

| Record                 | Standing                                                                |
| ---------------------- | ----------------------------------------------------------------------- |
| The registry of record | **Authority for holdership** of a registry-backed asset                 |
| The chain              | The projection of that registry, and the settlement record              |
| ArtFi's projection     | **Authoritative for nothing.** Read-only, reconcilable, no rights claim |

#### Consequence, recorded for decision

With three records, reconciliation has three legs rather than two. `M2.8` already requires the
projection never to diverge from chain state without reporting the divergence. A registry-versus-chain
divergence is a new case, and **which way it resolves is a client decision, not an engineering
one**. Settled either way: **ArtFi never resolves a divergence by asserting its own projection.**
It reports.

### 1.1 Brand and attribution

- Product brand: `ArtCCH:ArtFi`. UI uses approved ArtCCH VI logo assets only; no agent-drawn or
  synthesized logos.
- Giraffe ArtFi Corp. is technical support and appears in the footer, not as the primary brand.
- Bazaar is not an ArtFi module and must not appear in ArtFi content.
- Where an approved Giraffe VI asset is unavailable, use text.

### 1.2 Users

| Role               | Share | Needs                                                                   |
| ------------------ | ----- | ----------------------------------------------------------------------- |
| Asset owners       | —     | Upload an asset, mint, vault it, fractionalize, set issuance parameters |
| Fraction investors | ~60%  | Discover assets, buy/sell fractions, track holdings and P&L, vote       |
| Platform admins    | —     | Review submissions, moderate, handle appeals, monitor the system        |

---

## 2. Baseline: the inherited prototype

**The prototype is the starting line, not the finish line.**

`pics/*.png` and `fractional_steps/*` are **prototype screenshots**. They define visual and
interaction language to be preserved. They are **not** the acceptance target: a delivery that
reproduces these screens and nothing else has delivered zero of the six paid modules.

Every prototype surface falls into exactly one of three classes.

### 2.1 Class A — Functional in the prototype (preserve, do not rebuild)

Regression-protect these. Rebuilding them is out of scope and is not billable work.

- Wallet connection via RainbowKit; multi-wallet, network switching, address-derived avatars
- RWA creation wizard (3 steps): file upload, metadata, NFT mint
- DAO/vault creation wizard (4 steps): NFT selection, exact-token approval, vault deposit,
  fraction issuance — the nine `fractional_steps/` images are the authoritative flow
- Contract stack: `NFTFactory`, `VaultFactory`, `ERC721Vault`, `BasicNFT`
- Chain event monitor and DB synchronization service
- 12 read-side Go APIs (`/projects/RWAProjects`, `/projects/getprojectbyname`, `/projects/RWAs`,
  `/projects/usertokens`, `/projects/Fractionals`, `/projects/uploadrwa`, …)
- MySQL schema: `RwaProjects`, `Rwas`, `Fractional`, `sys_users`, `sys_authorities`
- Presentation layer: home carousel, market grid, personal center, responsive layout

### 2.2 Class B — UI shell only (the core of this engagement)

Rendered in the prototype with mock or static data. **Each must be made real.** This is where the
paid work concentrates.

| Prototype surface      | Current state                                                           | Required end state                                                               |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Auction (`/rwadetail`) | Countdown, bid button, bid-history list, top-bid display — all static   | Auction contract, on-chain bid recording, live price push, auction state machine |
| Trade history          | `mockTradeHistory` hard-coded array                                     | Real on-chain + off-chain trade records, type filters, live status               |
| Search and filtering   | Input box, price/status/favorite filters, sort options — non-functional | Backend search API, filter parameter handling, sort, pagination                  |
| Personal center P&L    | Static totals                                                           | Live holdings, cost basis, realized/unrealized P&L                               |
| Notifications          | Absent                                                                  | Transaction alerts, system messages, delivery preferences                        |

### 2.3 Class C — Not present in the prototype (new build)

- User authentication and session (JWT), wallet-address binding, role/permission enforcement
- Order book, matching engine, order lifecycle, and position projection — as an intermediary, per
  §4.2. No custody ledger and no ArtFi-operated settlement
- Advanced governance: proposal thresholds, snapshot voting power, timelock execution
- Revenue distribution
- Multi-signature administration
- Admin console: moderation, appeals, audited decisions, platform controls
- Production operations: CI/CD, clustered deployment, DB replication, monitoring, alerting

---

## 3. Scope contract

Derived from the quotation. Every requirement in §4 traces to exactly one module. Work that
traces to no module is out of scope and must not be started.

Commercial terms per module are held outside this repository and are not reproduced here. The
module boundaries below are the scope contract; progress against them is counted in `STATUS.md`
items, never in effort or money (`ACCEPTANCE.md` §6.1).

| #   | Module                                      | Class emphasis |
| --- | ------------------------------------------- | -------------- |
| M1  | Smart contract enhancement + mainnet deploy | B + C          |
| M2  | Backend core trading system                 | C              |
| M3  | Frontend UX and feature completion          | B              |
| M4  | DAO governance and administration           | C              |
| M5  | Hardening and security audit                | —              |
| M6  | Operations, monitoring, production deploy   | C              |

### 3.1 Schedule

Per the Gantt. Phase boundaries are contractual checkpoints; intra-phase sequencing is the
delivery team's.

| Phase | Window        | Content                                                         |
| ----- | ------------- | --------------------------------------------------------------- |
| P1    | 07-06 → 07-13 | Requirements analysis and solution design                       |
| P2    | 07-13 → 09-07 | Core development: M2 backend, M1 contracts, M4 DAO, M3 frontend |
| P3    | 09-07 → 09-21 | System integration and testing                                  |
| P4    | 09-21 → 10-05 | Security audit and remediation                                  |
| P5    | 10-05 → 10-12 | **Mainnet deployment and go-live**                              |

> Open item: the Gantt window and the task list's stated duration disagree. Reconcile before P1
> sign-off. The figures are held outside this repository.

### 3.2 Staged delivery — UI-visible is the delivery standard

Client ruling of 2026-09-19, recorded in
[`DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md) §3.
Two sentences, both binding:

1. **ArtFi is delivered in stages. It is not one complete end-state handover.**
2. **Every delivery is measured by what is visible and operable in the UI.**

**Only the complete RWA market is a single end-state delivery.** ArtFi as an ERC-8415-standard
artwork RWA market (§1) is the one thing handed over whole; everything on the way to it is a stage,
and a stage is handed over when its UI is real.

#### 3.2.1 What "UI-visible" means

A stage is **delivered** when a user in that stage's intended role can carry out the stage's
function **from the ArtFi UI**, on desktop and mobile, with G1 human visual sign-off and evidence
per `ACCEPTANCE.md` §3.

Not a stage delivery, on their own:

- a backend endpoint that works but no screen reaches;
- a deployed contract with no UI path to it;
- a passing test, a generated client, or an OpenAPI entry;
- a fixture or mock rendered as if it were live data (`AGENTS.md` §5).

These are real progress and they are counted as `IMPLEMENTED-NOT-VERIFIED` item by item. They are
not a stage handover. **The screen is the deliverable.**

#### 3.2.2 What this does not change

- **No new gate.** G1–G4 in `ACCEPTANCE.md` §4 are unchanged, and nothing here adds to them.
- **No new status value.** Item status stays the six values in `ACCEPTANCE.md` §2.
- **No new requirement and no new scope item.** Every stage below groups requirements that already
  exist in §4; no `STATUS.md` row is created, moved or renumbered by this section.
- **`ACCEPTANCE.md` §6 items 7–10 remain the terminus for the complete RWA market**, not for each
  stage. A stage does not require mainnet.
- **Stage IDs are labels for grouping, not authority.** Citing one proves nothing; cite the
  requirement.

#### 3.2.3 The stages

Each row is one product line of §1, plus operations. The UI column is the delivery test for that
stage.

| Stage   | Scope                       | UI that must be visible and operable                                                                                                | Draws on   |
| ------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `S-CH`  | Charity NFT editions        | Edition page with the CH.8 rights disclosure, purchase path, wallet-verified holder access to the watermarked copy, venue deep link | CH.1–CH.11 |
| `S-XM`  | External marketplace mirror | Attributed listings, offers, sales, transfers and cancellations, each with source, time, freshness and a deep link                  | XM.1–XM.6  |
| `S-WA`  | Whole artwork, ERC-8415     | Asset page showing registry-backed holdership, listing, and a signature-settled fill the user signs                                 | M1, M2, M3 |
| `S-FR`  | Fractions and fund tokens   | Fractionalization and fund-token surfaces, and the governance surface the asset model defines                                       | M1, M2, M4 |
| `S-OPS` | Operations                  | Monitoring, alerting and operator surfaces that an operator actually works from                                                     | M6         |
| `S-MKT` | **The complete RWA market** | The three product lines operating together as one market                                                                            | all of §4  |

`S-MKT` is the end state and the only row delivered whole. `M5` (hardening and security audit) is
not a stage: it is continuous and gated by G3-A/G3-B.

#### 3.2.4 Visual design is the client's track; a stage is verified on function

Client ruling of 2026-09-19: **the UI is being redone in Figma, and the delivered version is
verified on functional delivery.**

So "UI-visible" in §3.2.1 means **the function is operable from a screen** — not that the screen is
final, and not that a reviewer is accepting its visual design. A stage passes on what a user can
do, not on how it looks.

Three consequences, and no more:

- **A pending Figma redesign neither blocks nor invalidates a stage delivery.** The visual layer is
  a client-side track, like exempt-market compliance in §2.3 of the rollout directive.
- **Delivery builds should re-skin cheaply.** Prefer the existing shared classes and semantic
  markup over surfaces styled bespoke, so replacing the design costs stylesheet work rather than
  rebuilt components. This is an engineering consequence of the ruling, not a new requirement.
- **Nothing about the function relaxes.** Fail-closed behaviour, the absence of a preview, the
  rights disclosure and the verification gates are functional requirements, not styling, and a
  redesign may not drop them.

> **Recorded, not decided.** G1 in `ACCEPTANCE.md` §4 tests parity against `pics/*.png` and
> `fractional_steps/*`, which have never existed in this repository — they are the single `BLOCKED`
> item (M3.10). If the Figma work replaces that baseline, G1's reference changes. **Which artefact
> G1 tests against after the redesign is a client decision** and is not made here.

#### 3.2.5 Stage order is not a build order

The order in which stages are **opened for business** is the client's rollout sequence in §1.0.0 —
charity first, then whole artwork behind its prerequisites, then fractions behind exempt-market
compliance. That sequence governs switch-on only.

**A stage that has not opened is still built, tested, counted and kept launch-ready.** Delivery
order is the client's to set; it is not derived here, and no stage blocks another stage's
engineering. An agent that reads this table as a gate ladder repeats the `G0` mistake #91 and #94
removed.

---

## 4. Functional requirements

### 4.1 M1 — Smart contracts

- **Auction contract**: English auction with reserve price, minimum increment, extension on
  late bid, settlement, and refund of losing bids. Emits events consumed by the monitor service.
- **Revenue distribution**: pro-rata distribution to fraction holders by snapshot balance;
  claim-based withdrawal, not push transfers.
- **Advanced governance** (see M4 for behavior): `ERC20Votes` historical snapshots, proposal
  thresholds, `TimelockController` execution.
- **Multi-signature administration**: privileged contract operations require an m-of-n safe. No
  single EOA holds upgrade, pause, or treasury authority.
- **Deployment tooling**: deterministic build, deployment scripts, gas optimization pass,
  verified source on the block explorer, address manifest per network.
- Full unit, fuzz, invariant and integration test suites.

### 4.2 M2 — Backend core trading

**Client ruling, 2026-08-30: ArtFi is a trading intermediary, not an exchange.** This resolves the
conflict recorded below and governs every requirement in this section.

The distinction is not cosmetic. It fixes one invariant:

> **ArtFi never takes possession of, and never holds authority to move, a user's funds or assets.**
> Every change to a user's holdings originates from a signature that user produced for that
> specific trade. ArtFi records intent and finds counterparties; the chain settles.

- **Authentication**: wallet-signature login (SIWE-style nonce challenge), JWT issue/refresh,
  session persistence, wallet-address binding, logout. Unauthenticated users cannot trade.
- **Order system**: limit and market orders for ERC-20 fractions; create, amend, cancel; order
  lifecycle states; partial fills. An order is a **signed intent** — an EIP-712 payload the user
  signs, authorizing **up to a stated maximum quantity at stated terms**, and nothing else.
  Amending replaces a signed intent; cancelling revokes one. The backend stores intents and
  signatures; it never stores a claim on assets.

  Partial fills consume the intent cumulatively against **on-chain fill state keyed by the intent's
  hash**: each fill increments the consumed quantity, a fill that would exceed the authorized
  maximum reverts, and a fully consumed or revoked intent cannot be filled again. The signature is
  therefore neither burned on first use — which would make partial fills impossible — nor reusable
  without limit. Revocation is on-chain, so a cancelled intent cannot be filled even by a
  counterparty holding the signature.

- **Matching engine**: price-time priority; deterministic and replayable from the order log. Its
  output is a settlement transaction submitted to the market contract, carrying both parties'
  signatures. Matching is discovery, not execution: a match that no party signed cannot settle.
- **Position projection** (replaces custodial fund management): balances and positions per user per
  asset, **projected read-only from chain events** and reconcilable against chain state. Double-entry
  bookkeeping applies to the projection's own integrity, not to a claim on customer property.
  Neither Redis nor MySQL is ever an ownership authority — the chain is.
- **Trade history service**: unified on-chain and off-chain event record, queryable and filterable.
- **Admin API**: moderation, appeals, platform configuration — all privileged actions produce
  durable audit records. **No administrative action may move, freeze, or reassign a user's assets.**
  Administration governs listings, visibility and platform configuration, never property.
- Go APIs versioned and documented in OpenAPI 3.1; bounded error responses that never expose
  secrets or internal topology.

#### 4.2.1 Two business roles, one set of rules

**Client ruling, 2026-08-30.** ArtCCH:ArtFi operates in two business roles:

| Role                    | Whose assets are sold    |
| ----------------------- | ------------------------ |
| **自营** — proprietary  | ArtCCH's own holdings    |
| **中介** — intermediary | a third party's holdings |

**These are business roles, not technical privileges.** When ArtCCH sells its own inventory it acts
as a market participant: its wallet is a participant wallet, subject to exactly the rules that
govern any other. Treat ArtCCH's assets as customer assets whose account happens to belong to
ArtCCH.

Three things follow, and each is a requirement:

1. **No privileged path.** There is no seller allowlist, no role gating who may list, and no
   administrative call that can move ArtCCH's holdings any more than it can move a customer's. The
   entry points being open to any address is correct under this model, not a gap.
2. **Matching is blind to seller identity.** Price-time priority takes no input from who the seller
   is. ArtCCH's own orders receive no ordering, latency, visibility or fee advantage, and the
   replayable order log is what proves it.
3. **Disclosure, not privilege.** A listing discloses whether its seller is ArtCCH. The 自营/中介
   distinction is visible to users and to accounting; it never appears as a branch in the settlement
   path.

#### 4.2.2 Settlement custody

`ArtFiMarket.sol` currently escrows: `createListing` pulls the seller's tokens into the contract and
`buyFixed` credits the seller's proceeds there until withdrawn. That is contract escrow, not ArtFi
custody — the operator holds no keys over any balance in it — but it does place assets in a
platform-deployed contract between listing and settlement.

**Client ruling, 2026-08-30: signature settlement.** The fixed-price and order-book path settles by
signature — assets remain in the owner's wallet and move only in the atomic fill the owner signed.
`_pullExact` on listing is removed from that path; the market contract pulls from both parties at
fill time and never holds a resting balance.

Escrow is retained **only for auctions**, where locking the asset for the auction's duration is
structurally necessary: an auction over unlocked tokens lets the seller transfer the asset away
after seeing the winning bid, leaving the bidder to have locked funds for the auction's duration
for nothing. The lock there is one the seller accepts to run an auction, bounded by `startsAt` and
`endsAt`, released by a `settleAuction` that is deliberately not pausable.

Both rules apply symmetrically under §4.2.1. ArtCCH selling its own inventory settles by signature
on the fixed-price path and escrows on the auction path, on identical terms to any other seller.

Consequences that must hold in implementation:

- The fixed-price path holds no assets at rest, so there is no pooled balance to drain and nothing a
  pause can trap.
- A seller may keep the same tokens listed in several places at once; a listing is an authorization,
  not a transfer.
- The auction path keeps escrow and therefore keeps the finding below — including for ArtCCH's own
  inventory, which the same pause would trap.

**Finding, 2026-08-30 — pausing traps escrowed listings.** `settleAuction` and `withdrawCredit` are
deliberately not `whenNotPaused`, so a pause cannot strand settled proceeds. `cancelListing` is
`whenNotPaused`, and it is the seller's only exit from an active listing. A pause therefore locks
every seller's escrowed asset with no way out until someone unpauses. Nothing is stolen — the
contract exposes no administrative path to user funds — but the assets are held.

The ruling narrows this to the auction path, and does not remove it: drop `whenNotPaused` from
`cancelListing`, or add an escape that works while paused. In scope for G3-A (`ACCEPTANCE.md` §4).

#### 4.2.3 Recorded conflict

The superseded document asserted that ArtFi operates no order book, matching engine, custody ledger
or settlement system. M2 as quoted is titled "backend core trading system". The ruling
above resolves this: order book, matching and trade history are **in scope and built**; the custody
ledger and ArtFi-operated settlement are **not built**, replaced by the position projection and
on-chain settlement described above. Six of M2's seven requirement groups survive intact; only fund
management changes character.

Whether an intermediary of this shape carries licensing obligations in any given jurisdiction is a
legal question for the client's counsel, not an implementation decision.

### 4.3 M3 — Frontend

- Make every Class B surface functional against the M2 APIs.
- Real auction UI bound to M1 events; real trade and bid history; working search, filter, sort,
  pagination; complete personal center with live positions.
- Admin console UI.
- Mobile adaptation and optimization across all surfaces.
- Preserve Class A visual language: any deviation from `pics/*.png` requires explicit approval and
  is recorded in `STATUS.md`.
- Eight-language support: `EN / 简 / 繁 / FR / ES / DE / 한 / 日`. English is the authoritative
  source for FR/ES/DE/KO/JA; Chinese is never an intermediate translation source. The approved
  translation module is the primary translator; `<LLM_PROVIDER_A>` may proofread only, and is
  swappable. Translation failure retains authoritative English — never blank content or leaked
  internal errors.

### 4.4 M4 — DAO governance and administration

- Vault custody of the underlying ERC-721 must persist for membership to remain valid.
- Voting power from `ERC20Votes` historical snapshots, preventing transfer-based double voting.
- Proposal threshold: ≥10% of historical voting supply.
- Approval thresholds: market migration >50%; physical-action assistance >66.6667%;
  forced-buyout initiation >80%, additionally requiring independent pricing evidence
  (T0–T-30 VWAP or the latest 10 actual trades).
- Off-chain proposal drafting and display, on-chain vote, timelock queue, execution, public result.
- Automatic debit, forced liquidation, real buyout settlement, and unilateral ArtCCH voting
  control remain disabled in this cycle.

### 4.5 M5 — Hardening and security audit

- Internal security review and penetration test.
- Code hardening; remediation of all findings.
- **Third-party audit by a recognized firm** (budgeted) covering the contract suite.
  Audit report and remediation evidence are delivery artifacts.
- Secret, private-key, raw-signed-transaction and prohibited-plaintext scans in CI.
- Private keys and seed phrases never enter Web, API, MySQL, servers, GitHub, CI or logs.
  Signing remains local; raw signed transactions never reach stdout, Git, CI or a server.

### 4.6 M6 — Operations

- CI/CD pipeline to staging and production.
- Production cluster: load balancing, MySQL primary/replica, backup and restore.
- Monitoring across application performance, host, and chain layers; log aggregation; alerting.
- Object storage validating MIME, size and SHA-256.
- Runbooks and operator documentation.

### 4.7 CH — Charity NFT editions

Added 2026-09-18 by client ruling. Charity NFT editions are the third product line (§1) and an
independent business module: they are **not** required to follow the ERC-8415 asset model and must
not be forced into it.

The rules below are not new. They are the product rules already stated in
[`CHARITY_EDITIONS.md`](CHARITY_EDITIONS.md), itemized here so they are traceable and countable in
`STATUS.md` — previously the module appeared in no requirement list at all.

- **CH.1** The first fixed charity supply is **13 works** — `UNIT-A01/04/05/11/14/15/16/17/20/21/22/23/24`,
  with a repeated `A16` counted once. Each is one ERC-1155 token ID with exactly `100` units, minted
  once and permanently fixed, at a recorded unit price of `0.01 ETH`. No additional-mint and no
  external burn entry point exists. **Open item 6 records the unresolved conflict**: 37 works /
  3,700 units were minted on Sepolia against this requirement's 13 / 1,300.
- **CH.2** The recorded primary unit price is `0.01 ETH`. ArtFi does not create, sign, match, fulfil
  or settle marketplace orders for these editions.
- **CH.3** Sellout may be recorded only after the distribution wallet holds a zero balance and the
  sale evidence is externally reconciled.
- **CH.4** Physical-donation acceptance by CCHS may be hash-recorded only after sellout is recorded.
- **CH.5** **The only holder benefit** is access to a high-resolution **watermarked** copy, released
  only after wallet ownership is verified.
- **CH.6** The unwatermarked master never enters public metadata, a website download, or any
  browser-delivered object. Charity masters never enter public storage.
- **CH.7** Public token metadata contains no artwork preview. An external marketplace may show a
  generic missing-image treatment; discovery must never be "fixed" by publishing the master.
- **CH.8** An edition conveys no copyright, physical title, possession, redemption, commercial-use
  or reproduction right. This must be disclosed wherever an edition is displayed or offered.
- **CH.9** All primary proceeds are designated for CCHS and routed to the CCHS-confirmed beneficiary
  wallet. Holders contact CCHS directly for any receipt. **ArtFi issues no receipt, determines no
  eligible amount, and promises no tax credit.** The receipt valuation policy is locked to the
  donation-date `ETH/CAD` fair market value from a CCHS-approved public source, retaining date,
  price, source and snapshot hash, and fails closed without CCHS written confirmation.
- **CH.11** The master and the watermarked holder file must hash differently, and the holder file is
  delivered without a browser preview.
- **CH.10** The release package fails closed until the master, the distinct watermarked holder file,
  rights evidence, CCHS status and receipting-policy evidence, the non-zero beneficiary wallet and
  listing eligibility are all verified. `listingActionConfirmed` stays `false`; every external
  listing operation needs a fresh action-time confirmation.

### 4.8 XM — External marketplace mirroring

Added 2026-09-18. Charity editions and approved-external-marketplace mirroring are ArtFi's original
paired requirement. The mirroring side was implemented in `apps/api` but appeared in no requirement
list. These carry the original `MARKET-001`–`MARKET-006` forward; no rule is new.

- **XM.1** ArtFi-operated orders, bids, matching, claims and settlement stay shut. ArtFi is never a
  counterparty, never custodies, never matches and never settles.
- **XM.2** The approved-marketplace adapter is versioned: explicit backfill and realtime lifecycle,
  schema version, raw payload and source version retained. Sources come from an allowlist.
- **XM.3** A realtime stream and REST gap-fill converge to one correct state under duplication,
  out-of-order delivery, disconnect, reconnect, gaps, stale versions, sale-after-cancel and
  stale-listing-after-sale.
- **XM.4** **Mirror API and external deep link.** The mirror API reads activity from approved
  external marketplaces; **it does not create, sign, match, custody, fulfil or settle on their
  behalf**. Each record retains the external market, order ID, time, freshness and an **HTTPS deep
  link out to the venue**, because OpenSea is a live venue for every product line and a user must be
  able to reach it.

  > **Conflict outstanding — needs a client decision.** `ACCEPTANCE.md` §7.8 still fails the audit
  > when the public UI exposes an external-marketplace redirect. With OpenSea live as a venue that
  > rule and the deep link required here cannot both stand. This document does not change
  > `ACCEPTANCE.md` unilaterally.

  > **Scope note.** `market_orchestration.go` (628 lines) submits transaction intents to an external
  > market. That is orchestration rather than mirroring. It is retained — `AGENTS.md` §3 forbids
  > removing working code on provenance alone — and whether it is in scope now follows from §1's
  > rollout sequence, not from this row. It is not evidence for XM.4.

- **XM.5** Data claims are accurate. Local fixtures are labelled as such; "realtime" may be claimed
  only by a connected adapter reporting observation time and freshness; a mainnet stream event is
  never presented as a testnet one.
- **XM.6** The result state machine covers `initiated`, `awaiting-wallet`, `submitted`, `accepted`,
  `rejected`, `pending`, `confirmed`, `failed` and `cancelled`, and converges with the external
  market's authoritative state under disconnect, retry, duplicate submission, external cancellation,
  chain reorg and out-of-order callbacks.

---

### 4.7 continued — charity release dependency

Go-live additionally depends on the CCHS-side written evidence listed in
[`CHARITY_EDITIONS_PRECHAIN_EVIDENCE.md`](CHARITY_EDITIONS_PRECHAIN_EVIDENCE.md) under
"Release blockers". Those gate release, not implementation: CH.1–CH.10 are built and tested against
TEST_ONLY fixtures without them.

---

## 5. Non-functional requirements

| Dimension      | Requirement                                                   |
| -------------- | ------------------------------------------------------------- |
| API latency    | < 500 ms (p95)                                                |
| Page load      | < 3 s                                                         |
| Trade confirm  | < 30 s excluding block confirmation                           |
| Wallet connect | < 2 s                                                         |
| Gas estimation | < 5 s                                                         |
| Concurrency    | 100+ concurrent users, 50+ concurrent trades                  |
| Availability   | Stable for 48 continuous hours post-deployment                |
| Accessibility  | Keyboard navigation, accessible names, reduced-motion support |

---

## 6. Networks and the promotion path

**Testnet is a gate, not a destination.** The product ships to mainnet.

```
Hoodi (560048)  →  integration green  →  simulated audit passed (G3-A)  →  ACCEPTANCE
                →  third-party audit passed (G3-B)  →  remediation verified
                →  MAINNET DEPLOY  →  go-live
```

- Development and integration write-testing chain: **Hoodi, chain ID `560048`**, per
  `DIRECTIVE_2026-08-24_HOODI.md`. Base Sepolia `84532` is superseded. Hoodi is the test chain and
  implies nothing about the production chain, which remains an open written decision.
- Mainnet deployment is **in scope** (M1, phase P5) and is gated on, not excluded by, testnet
  results. Complete testnet verification plus a passed third-party audit **constitutes** the
  authorization to deploy to mainnet; no separate approval cycle is required.
- Any requirement that does not inherently need mainnet must be verified on testnet first.
  "Will be tested on mainnet" is not an acceptable disposition for a wallet, contract, DAO, API,
  admin, UI, translation, metadata, preview, security or failure-path gap.
- Where a third-party service objectively does not support the test chain, only that service's
  mainnet-only write action is deferred; its adapter, mirror, validation, error handling and
  non-write integration tests remain required on testnet.
- RPC, simulation, estimation, broadcast and receipt checks originate from the approved
  non-sandbox Singapore execution boundary.

---

## 7. Validation dataset

**Conflict recorded, resolved by the later ruling (§0).** This section previously read "the charity
artwork set is test payload used to exercise the platform, **not a product module**". The client
ruling of 2026-09-18 makes charity NFT editions a product line and an independent business module,
specified at §4.7. The two cannot both stand, and §0 requires the latest explicit written client
requirement to control, with the conflict recorded rather than silently resolved. The superseded
sentence is reproduced here for that reason.

What remains true is narrower: **the historical 37-work charity batch on Ethereum Sepolia is a
frozen record, not the validation dataset.** Runtime validation uses the separately generated Hoodi
AI payload described below. Delivery is not defined by either payload.

### 7.0 Two payloads, two chains

The charity set was minted on **Ethereum Sepolia** before the chain moved. It is a completed record
of real assets and **does not migrate**: 37 works, 3,700 units, frozen as superseded, never
re-minted and never rewritten. Its metadata hashes are bound on chain and its verifiers stay pinned
to `11155111` for as long as they validate those artifacts.

Runtime testing on **Hoodi** therefore uses a **separately generated AI artwork payload**, produced
by the delivery side. It exercises the same paths — mint, atomic batch, vault, fractionalization,
DAO, market — without touching the real record.

**Every asset in the Hoodi payload is a test asset. It carries no real-world value and no
transaction involving it has legal effect.** That statement is mandatory and must appear in the
token metadata (as `TESTNET`, `NO REAL-WORLD VALUE`, `NO LEGAL EFFECT`), at contract or series
level at deployment, on screen wherever the set is displayed, and as a top-level field in the batch
manifest.

Isolation rules, each an audit failure if broken, by analogy with §7's treatment of A02:

1. Its own namespace — never written into `release/mint-batches/ye-yongrun-unit-a01-a38` or any
   other existing batch directory.
2. Its own contract deployment — never the Sepolia `ArtFiCharityEditions` instance.
3. No real artist's name, signature, work title or style description, and no image that could be
   confused with a real work.
4. Never present in a production or mainnet manifest.
5. No association with CCHS donation, receipt, valuation or holder-advantage language. That path
   belongs to the real batch alone and stays gated on written evidence.

- Formal set: `UNIT-A01`, `UNIT-A03`–`UNIT-A38` — 37 artworks, exactly 100 immutable ERC-1155
  units each, 3,700 aggregate. Batch creation is atomic.
- `UNIT-A02` is excluded from the formal set and from every production/mainnet manifest. It is a
  separate test-chain-only physical-asset/DAO test fixture with exactly 100 test NFTs and its
  own compliant preview, in an isolated namespace. A02 must be hard-rejected by the formal batch.
- Public previews are separately generated web-safe derivatives. No preview URL may expose an
  unwatermarked high-resolution master or a master download path. Charity masters never enter
  public storage.
- Inscription: English is the sole authoritative language; file is 15,254 bytes, LF, no BOM,
  SHA-256 `1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01`. Superseded hashes
  must not appear in release artifacts.
- Initial ICO record price `0.01 ETH` per NFT. Proceeds actually received by the issuer are
  donated 100% to CCHS. NFTs convey no physical title, fractional physical ownership, redemption
  or delivery right. CCHS is the sole donation-receipt issuer; purchase does not automatically
  qualify for a receipt.

### 7.1 External marketplace mirroring

- ArtFi mirrors attributed information from approved external marketplaces and displays it inline,
  and links out to the venue.

  > **Superseded, recorded per §0.** This bullet previously continued "the UI does not redirect
  > users to OpenSea". OpenSea is a live venue for every product line (§1, ruling of 2026-09-19), so
  > the UI must be able to send a user there. `ACCEPTANCE.md` §7.8 still says the opposite and awaits
  > a client decision — see §4.8 XM.4.

- ArtFi does not sign, custody, match or settle any external transaction.
- If the external marketplace does not support the selected test chain, discovery tests record
  `unsupported-chain` and are deferred to mainnet. No result may be substituted or invented.

---

## 8. Explicitly out of scope

- Native mobile applications (iOS/Android). Mobile web adaptation is in scope.
- Chains other than the approved EVM test chain and its mainnet counterpart.
- Automatic debit, forced liquidation, and real buyout settlement.
- Fiat on/off-ramp.
- Any feature not traceable to a module in §3.
