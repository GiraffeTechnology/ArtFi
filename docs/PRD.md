# ArtCCH:ArtFi — Product Requirements Document

Version: 2026-08-30
Status: Draft for approval
Repository: `GiraffeTechnology/ArtFi`
Supersedes: `PRD_AND_DELIVERY_STANDARD.md`
Amended by: `DIRECTIVE_2026-08-24_HOODI.md` (test chain), `DIRECTIVE_2026-08-30_DELIVERY.md` §1.2.1
(Hoodi test payload)

---

## 0. Document set and authority

This PRD defines **what is built**. It is one of three documents; do not merge them.

| Document        | Answers                                      | Changes when            |
| --------------- | -------------------------------------------- | ----------------------- |
| `PRD.md`        | What must exist and how it must behave       | Scope change (approved) |
| `ACCEPTANCE.md` | What proves it exists and how it is promoted | Process change          |
| `STATUS.md`     | Where each item stands right now             | Every delivery commit   |

Scope authority is the signed quotation (450 person-days / USD 155,000, six modules).
Functional authority is the inherited prototype documentation
(`任务清单含mvp已完成及Dao_钱包技术实施方案及清单.pdf`, 155 pp.).
Schedule authority is `项目甘特图.pdf`.
Where these conflict, the latest explicit written requirement from the client controls, and the
conflict is recorded — never silently resolved.

---

## 1. Product definition

ArtCCH:ArtFi is a Real-World-Asset (RWA) platform that takes a physical or high-value digital
asset, mints it as an ERC-721, locks it in a vault, issues ERC-20 fractions against it, and lets
holders trade those fractions and govern the underlying asset through a DAO.

**This engagement is not a greenfield build.** A working prototype/MVP already exists and is
deployed. This engagement converts that prototype into a commercially operable product: real
backends behind the existing screens, real order flow, real governance, real money, on mainnet.

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

**This is the section codex got wrong. The prototype is the starting line, not the finish line.**

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

| #   | Module                                                                 | Days    | USD         | Class emphasis |
| --- | ---------------------------------------------------------------------- | ------- | ----------- | -------------- |
| M1  | Smart contract enhancement + mainnet deploy                            | 95      | 28,500      | B + C          |
| M2  | Backend core trading system                                            | 115     | 34,500      | C              |
| M3  | Frontend UX and feature completion                                     | 90      | 27,000      | B              |
| M4  | DAO governance and administration                                      | 70      | 21,000      | C              |
| M5  | Hardening and security audit (incl. third-party firm, est. USD 20,000) | 35      | 30,500      | —              |
| M6  | Operations, monitoring, production deploy                              | 45      | 13,500      | C              |
|     | **Total**                                                              | **450** | **155,000** |                |

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

> Open item: the Gantt spans ~15 weeks while the task list states 12 weeks / 5–6 people /
> 720–864 person-hours, against a quotation of 450 person-days. Reconcile before P1 sign-off.

---

## 4. Functional requirements

### 4.1 M1 — Smart contracts

**Client ruling, 2026-09-07: every asset traded on ArtFi Market corresponds to a real object,
and that correspondence is established by two off-chain paths of record.**

1. **文保链**, or an equivalent registry institution or registry chain;
2. **ArtCCH**.

An oracle carries those attestations on-chain so that minting is gated on correspondence rather
than on a role alone. **The token is a claim about an object that a path of record already
attests to; it is never the origin of that claim.**

Why this is a contract requirement and not a process one: without an on-chain check, an
unbacked token is indistinguishable from a genuine one at every downstream layer — it can be
deposited, fractionalized, listed and sold for real payment. Its lack of backing would be a fact
about the physical world that the system cannot see. **Correspondence has to be checkable where
the token is created, because nothing after that point can recover it.**

- **Auction contract**: English auction with reserve price, minimum increment, extension on
  late bid, settlement, and refund of losing bids. Emits events consumed by the monitor service.
- **Revenue distribution**: pro-rata distribution to fraction holders by snapshot balance;
  claim-based withdrawal, not push transfers.
- **Advanced governance** (see M4 for behavior): `ERC20Votes` historical snapshots, proposal
  thresholds, `TimelockController` execution.
- **Multi-signature administration**: privileged contract operations require an m-of-n safe. No
  single EOA holds upgrade, pause, or treasury authority.
- **Asset correspondence**: `RWARegistry.createAsset` accepts a mint only against a valid
  attestation from an accepted path of record. Today its only substantive gate is
  `REGISTRAR_ROLE`; the metadata hash and recipient are caller-supplied and nothing verifies
  that they describe a real object.
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
or settlement system. M2 as quoted (USD 34,500) is titled "backend core trading system". The ruling
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
  source for FR/ES/DE/KO/JA; Chinese is never an intermediate translation source. AIVAN's
  translation module is the primary translator; Qwen may proofread only. Translation failure
  retains authoritative English — never blank content or leaked internal errors.

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
- **Third-party audit by a recognized firm** (budgeted USD 20,000) covering the contract suite.
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

The charity artwork set is **test payload used to exercise the platform**, not a product module.
It proves batch minting, isolation, and preview handling work correctly. Delivery is not defined
by it.

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

- ArtFi mirrors attributed information from approved external marketplaces and displays it inline;
  the UI does not redirect users to OpenSea.
- ArtFi may prepare a reviewed external-market transaction for an external wallet but does not
  sign, custody, match or settle that external transaction.
- If the external marketplace does not support the selected test chain, discovery tests record
  `unsupported-chain` and are deferred to mainnet. No result may be substituted or invented.

---

## 8. Explicitly out of scope

- Native mobile applications (iOS/Android). Mobile web adaptation is in scope.
- Chains other than the approved EVM test chain and its mainnet counterpart.
- Automatic debit, forced liquidation, and real buyout settlement.
- Fiat on/off-ramp.
- Any feature not traceable to a module in §3.
