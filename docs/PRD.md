# ArtCCH ArtFi Product Requirements Document

Version: 2026-10-04  
Repository: `GiraffeTechnology/ArtFi`  
Delivery destination: `https://io.artcch.com`  
Companions: `ACCEPTANCE.md` for evidence and promotion, `STATUS.md` for current evidence

ArtCCH:ArtFi is a commercial application built on an existing product and MVP. The current delivery
covers three distinct sections: digital NFTs linked to the CCHS cultural and charitable workflow,
whole-artwork RWA receipts, and inherited fractional trading with DAO governance. This document
coordinates their definitions, preserves the existing functional scope, and separates working
stage delivery from business opening, final production assembly, and Stage 2 autonomous operation.

## 0. Authority and document control

### 0.1 Requirement authority

[Issue #110](https://github.com/GiraffeTechnology/ArtFi/issues/110) remains the inherited product
baseline and incorporates [Issue #84](https://github.com/GiraffeTechnology/ArtFi/issues/84).
Explicit later client instructions amend the affected provisions. The latest explicit instruction
controls a conflict; unchanged requirements remain in force. This PRD records those requirements
and is not an independent source of agent-created scope.

The client clarification of 2026-10-02 establishes this product order and meaning:

1. NFTs have no physical-asset backing, connect to CCHS at `https://cchsc.ca`, and trade primarily
   on OpenSea. Primary does not mean exclusive.
2. A whole-artwork RWA token is a delivery voucher or warehouse receipt. ArtFi is an ERC-8415
   standard commercial product for that application.
3. Fractional trading and DAO are inherited from the original PRD and MVP. They are continuing
   product scope, not a newly added section.

The requested delivery destination is `io.artcch.com`. This destination does not select a
production chain or, by itself, authorize real-asset or real-money transactions.

The current NFT experience mirrors OpenSea operations inside ArtFi. The frontend-to-venue
relationship is analogous to trading exchange-listed securities through a securities firm's
website: users discover assets and manage orders in ArtFi while the integrated venue and
protocol provide the order and settlement infrastructure. This is a workflow analogy, not a
licensing assertion, custody model, or expansion into securities products.

Use the following documents for their distinct purposes:

| Document        | Purpose                                                             |
| --------------- | ------------------------------------------------------------------- |
| `PRD.md`        | Product meaning, scope, and required behavior                       |
| `ACCEPTANCE.md` | Evidence and promotion process for the applicable stage             |
| `STATUS.md`     | Verified state, exact evidence, remaining work, and actual blockers |
| `AGENTS.md`     | Execution boundaries and prevention of unauthorized scope changes   |

An acceptance rule, status entry, review, or historical directive cannot enlarge product scope or
supersede an explicit client instruction. Record genuine conflicts and their source. Do not turn
an unanswered technical question into a new approval requirement.

### 0.2 Continuity and identifiers

Keep the existing M1–M6, CH.1–CH.11, XM.1–XM.6, NFR, and stage identifiers. The product ordering
in this document does not renumber requirement IDs, erase prior evidence, or promote any status.
The existing six status values in `ACCEPTANCE.md` remain unchanged.

The original material contains a broad product blueprint, MVP completion claims, and narrower
iteration boundaries. Preserve working implementation and requirements incorporated by #110 and
later instructions. In particular, distinguish inherited vault and fractionalization capability
from the later work needed to complete trading and advanced governance. Do not describe all DAO
or fractional work as a new expansion, or assume an MVP completion claim proves current delivery.

Commercial terms remain outside this repository. Existing module and schedule records do not
become evidence that a feature is implemented or that a financial action is authorized.

## 1. The three product sections

### 1.1 Digital NFTs and CCHS

These NFTs are digital editions without physical-asset backing. The CCHS relationship and the
existing charity-edition workflow remain part of the product. ArtFi links to CCHS at
`https://cchsc.ca` and preserves the applicable charity disclosures, proceeds rules, and
wallet-verified holder access defined in section 4.7.

OpenSea is the primary trading venue for this section, with other supported venues retained where
applicable. ArtFi at `io.artcch.com` is the native operational frontend for the corresponding
OpenSea NFT workflows: discovery, collection and item details, listings, purchases, offers,
offer acceptance, eligible order cancellation, and result tracking. Users complete these
workflows in ArtFi through official supported OpenSea APIs, SDKs, and settlement protocols.

Do not implement this requirement as a homepage redirect, outbound asset link, iframe, or
read-only catalog. Main NFT controls remain inside ArtFi. An optional external OpenSea website
link belongs in the footer, not the primary navigation or purchase flow. Retain source URLs
and venue attribution as evidence without using them as a substitute for native operations.
Unsupported or unconfigured operations remain visible with their actual availability reason;
their absence is an implementation gap, not a reduction of this product scope.

For the existing charity editions, the only holder benefit is access to the specified
high-resolution watermarked copy. They confer no physical title, possession, redemption,
commercial-use, reproduction, or copyright right. CCHS donation and acceptance records concern
the charitable workflow; they do not make an NFT a receipt for the physical artwork.

Charity editions are an independent module and are not forced into the ERC-8415 RWA model.
Batch-specific charity requirements remain batch-specific; they do not silently define every
possible future digital NFT collection.

### 1.2 Whole artwork RWA receipts

A token in this section represents the delivery voucher or warehouse receipt for one identified
whole artwork under its applicable custody and registry record. Describe the token as that
receipt, rather than as unrestricted legal title or as a fractional investment product.

The product relationship is:

```text
Identified artwork
  -> custody and registry record
  -> ERC-8415 receipt representation
  -> receipt transfer and applicable delivery or redemption lifecycle
```

ArtFi consumes ERC-8415 capabilities through Oracle. It does not become the ERC8415-Kit,
Oracle implementation, an independent wallet product, or the registry of record. Existing
asset-identity, approved-source evidence, registry-synchronization, ownership-related workflow,
and lifecycle requirements remain applicable to this section.

The inherited Stage 1 grounding rule applies to every RWA issued or traded through ArtFi: it
must correspond to an authenticated real-world asset or enforceable real-world right under its
product structure. Minting or activation requires machine-verifiable correspondence evidence
from approved sources, including applicable registry, warehouse, custody, certificate, or
provenance sources. A privileged ArtFi role alone cannot establish authenticity. This rule
also applies to the underlying RWA of section 1.3; registry synchronization applies where
the asset is registry-backed. The isolated TEST_ONLY boundary remains as defined in section 7.

ArtFi trading remains part of this section. Approved external venues and their attributed
mirrors remain supported as applicable. The NFT section's OpenSea integration does not
turn this section into a mirror-only product or delete its signed order and settlement paths.

The receipt model does not make `ownerOf`, an ArtFi balance, or a successful token transfer proof
that physical delivery or a registry change has completed. Show the relevant chain and registry
states separately. Preserve the existing lifecycle requirements; this clarification does not add
a separate logistics platform or a new global delivery prerequisite.

### 1.3 Fractional trading and DAO

This section continues the original RWA and DAO/Vault product: asset creation, ERC-721 minting,
NFT selection and approval, vault deposit, ERC-20 fractionalization, issuance parameters,
fractional holdings, buying and selling, and asset-specific governance. Finish the applicable
commercial workflows behind the inherited UI rather than replacing them with a new product.

The existing single-asset fund or participation model remains available where defined:

```text
Artwork or its applicable asset representation
  -> asset-specific vault or fund structure
  -> fractional or participation tokens
  -> trading and governance defined by that structure
```

A fraction is not automatically a whole-artwork delivery voucher. Economic and governance rights
follow the corresponding asset model. Token possession alone does not create additional voting,
physical title, delivery, or redemption rights.

This section is not generally exempt from ERC-8415. Preserve the Stage 1 RWA grounding and
approved-source correspondence evidence required by section 1.2 for its underlying RWA,
including an applicable enforceable real-world right. Preserve the relevant identity,
restriction, and lifecycle requirements from #110, incorporated #84, and later instructions,
and the registry requirements where the asset is registry-backed.
Apply them to the relevant asset and integration path, not by requiring completion of every
independent Oracle, Kit, or wallet product before any fractional function can be delivered.

ArtFi order flow, matching, signed settlement, history, portfolio, and governance remain in
scope. The digital NFT section's venue preference and the passive event adapter's read-only
boundary do not prohibit these functions or the native OpenSea workflow.

### 1.4 Rights and record authority

For registry-backed assets, the approved registry of record is authoritative for recorded
holdership within its scope. The chain is authoritative for token state and settlement records.
ArtFi's own MySQL, Redis, and other projections are reconcilable read models, not rights authorities.

| Record             | What it establishes                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| Registry of record | Recorded holder, physical parameters, and provenance within that registry's authority |
| Blockchain         | Token balances, contract state, and what settled on chain and when                    |
| ArtFi projection   | A read model of source events; no independent claim on property                       |

On divergence, show the records, their sources, and their different meanings. Do not substitute
chain token ownership for conflicting registry holdership, invent a registry update from a
settlement receipt, or resolve either from ArtFi's database.

ArtCCH's own-account registry and an approved third-party registry are treated as members of the
same source class. Authority belongs to the registrar role, not to ArtCCH as platform operator.
ArtFi consumes registry information and operates none of those registries in this application.
A registrar role confers no marketplace or settlement privilege.

### 1.5 Brand and users

- Product brand: `ArtCCH:ArtFi`. Use approved ArtCCH VI logo assets; do not synthesize replacement logos.
- Giraffe ArtFi Corp. is technical support and appears in the footer, not as the primary brand.
- Bazaar is not an ArtFi module and must not appear in ArtFi content.
- Use text where an approved Giraffe VI asset is unavailable.

The product serves NFT collectors and eligible edition holders; owners issuing whole-artwork
receipts or depositing assets for fractionalization; participants discovering, trading, tracking
holdings and voting; and administrators handling moderation, appeals, and system operations.
The historical planning estimate of roughly 60% fraction investors is not an acceptance metric.

## 2. The inherited prototype

The prototype is the starting point for commercial delivery. Preserve useful working behavior
and its visual and interaction language. Prototype screenshots, mock data, historical checkmarks,
and code presence are not runtime completion evidence.

### 2.1 Class A functionality to preserve

- RainbowKit wallet connection, supported external wallets, network switching, and address-derived avatars.
- The three-step RWA flow: file upload, metadata, and NFT minting.
- The DAO/Vault flow: NFT selection, exact-token approval, vault deposit, and fraction issuance.
- The `NFTFactory`, `VaultFactory`, `ERC721Vault`, and `BasicNFT` contract foundations.
- The chain event monitor and database synchronization service.
- The inherited Go read APIs, including `/projects/RWAProjects`, `/projects/getprojectbyname`,
  `/projects/RWAs`, `/projects/usertokens`, `/projects/Fractionals`, and `/projects/uploadrwa`.
- Existing MySQL structures including `RwaProjects`, `Rwas`, `Fractional`, `sys_users`, and `sys_authorities`.
- Home carousel, market grid, personal center, and responsive presentation.

These are inherited functional baselines to regression-test, not blanket assertions that the
current deployed product has passed verification. Rebuilding valid working surfaces without a
product need is not additional delivery.

### 2.2 Class B surfaces to complete

| Surface              | Inherited limitation                                     | Required behavior                                                            |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Auction              | Static countdown, bid controls, bid history, and top bid | Contract-connected bids, live state, history, settlement, and refunds        |
| Trade history        | Mock or static records                                   | Real attributed chain and application records, filters, and current status   |
| Search and filtering | UI without complete search behavior                      | API-backed search, filters, sort, and pagination                             |
| Personal center      | Static holdings or totals                                | Live positions, cost basis, and realized and unrealized P&L where applicable |
| Notifications        | Missing delivery behavior                                | Transaction alerts, system messages, and delivery preferences                |

### 2.3 Commercial completion and advanced functionality

The inherited commercial scope includes authentication and sessions, wallet binding,
authorization, orders, matching, signed settlement, position projection, advanced governance,
revenue distribution, multisignature administration, audited moderation, and production operations.

Some advanced functionality was added to the execution baseline after the earliest MVP document;
that does not make the underlying fractional and DAO product new. Preserve the currently
incorporated M1–M6 requirements. Separate their delivery stages instead of deleting a function or
pulling the entire final product into every stage.

## 3. Scope and delivery

### 3.1 Existing modules

| ID  | Module                                             |
| --- | -------------------------------------------------- |
| M1  | Smart contract enhancement and approved deployment |
| M2  | Backend core trading system                        |
| M3  | Frontend UX and functional completion              |
| M4  | DAO governance and administration                  |
| M5  | Hardening and security audit                       |
| M6  | Operations, monitoring, and deployment             |

CH and XM retain their existing requirement IDs and independent visibility in `STATUS.md`.
Mainnet deployment remains in the existing final delivery/go-live scope; it is not a condition
for completing each working stage. Do not relabel deferred or unfinished scope as out of scope.

### 3.2 Working stages at io.artcch.com

The current task is to complete and integrate the three product sections at `https://io.artcch.com`.
A section is delivered through real, operable screens on desktop and mobile, with the applicable
function and evidence. An endpoint, deployed contract, green unit test, fixture-backed page, or
static landing page alone is not that delivery.

Keep these existing stage labels as groupings of requirements, not new scope or approval gates:

| Stage | Functional delivery                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-CH  | Digital charity edition page, rights disclosures, native OpenSea-backed purchase path, and wallet-verified access to the watermarked holder file |
| S-XM  | Native OpenSea-backed discovery, listing, buying, offers, cancellation, and attributed result tracking with source, time, and freshness          |
| S-WA  | Whole-artwork receipt experience with distinct registry and token states and the applicable issuance, listing, and signed settlement path        |
| S-FR  | Inherited fractionalization, issuance, holdings and trading, plus the governance workflow defined by the asset model                             |
| S-OPS | The monitoring, alerting, and operator functions applicable to the delivered stage                                                               |
| S-MKT | The complete market combining all applicable product and final operational requirements                                                          |

M5 applies throughout. A stage's finite requirement set and actual test environment are recorded
before its handover. Later valid work remains visible without becoming an unrelated prerequisite.
The stage table does not add rows to the requirement denominator or change the status vocabulary.

Deployment of the requested web application to `io.artcch.com` is distinct from mainnet contract
deployment and real-asset or real-money business opening. Build, deploy, and verify the requested
working application within the authorized environment. Do not use the historical instruction to
assemble the final production market last as a reason to avoid this requested web delivery.

### 3.3 Delivery evidence and design

Use the existing evidence rules in `ACCEPTANCE.md` for the applicable stage. Cite the exact
reviewed commit, environment, chain, test or browser observation, and transaction receipt where
required. Report passed, failed, and not-run checks distinctly. Do not carry old evidence to a
changed head without checking its applicability.

Preserve working prototype behavior. The Figma redesign is a separate visual track; pending
redesign or missing `pics/*.png` and `fractional_steps/*` reference assets do not prevent unrelated
functional stage delivery. Record the missing comparison input honestly and use the functional
standard for the stage. Do not waive rights disclosures, protected-file handling, fail-closed
behavior, or verification because they are visible in the UI.

The existing G1–G4 promotion framework is not expanded. Human visual comparison and final
production evidence keep their applicable scope; no new global G0, per-item client confirmation,
all-partners-ready condition, or independent-wallet-complete condition is introduced.

### 3.4 Business opening and final assembly

Business opening and engineering progress are separate:

- The NFT section uses OpenSea as its primary, nonexclusive marketplace. Existing charity
  release evidence applies to the real charity release, not to isolated Hoodi technical tests.
- Whole-artwork commercial opening retains the existing Oracle, ERC-8415 wallet integration,
  and registry-projection requirements for the relevant receipt workflow. This does not make
  completion of the entire independent wallet product a prerequisite for every ArtFi section.
- Fractional commercial opening retains the existing client-side exempt-market compliance
  condition. It does not prevent building, testing, integrating, or demonstrating the section.
- An unopened function is still built, tested, counted, and maintained for its applicable rollout.

The complete market's production deployment, mainnet steps, 48-hour stability, and final operator
handover retain their existing final-stage placement. They are not imposed on every earlier stage.
Likewise, Stage 2 autonomous operating acceptance is separate from Stage 1 functional delivery.
A true interface or safety dependency blocks only the function that demonstrably needs it.

### 3.5 Historical schedule

The inherited schedule records P1 requirements/design on 07-06–07-13, P2 core development on
07-13–09-07, P3 integration/testing on 09-07–09-21, P4 audit/remediation on 09-21–10-05, and P5
mainnet/go-live on 10-05–10-12. The recorded disagreement between the Gantt and task-list duration
is a historical commercial scheduling issue. It does not justify reopening P1 or delaying current
working-stage delivery. This rewrite makes no new deadline or commercial commitment.

## 4. Functional requirements

### 4.1 M1 Smart contracts

Preserve and complete the inherited NFT, vault, and fractionalization foundations and their
applicable asset model. The existing enhancement scope includes:

- English auctions with reserve price, minimum increment, late-bid extension, settlement,
  losing-bid refunds, and monitor-consumable events.
- Pro-rata revenue distribution using snapshot balances and claim-based withdrawals rather
  than push transfers.
- `ERC20Votes` historical snapshots, proposal thresholds, and `TimelockController` execution.
- Multisignature administration for privileged contract operations. No single EOA holds
  upgrade, pause, or treasury authority.
- Deterministic builds, deployment scripts, gas optimization, verified source on the block
  explorer, and an address manifest per network.
- Unit, fuzz, invariant, and integration tests for the applicable contract behavior.

Do not reinterpret the NFT section's venue preference as removal of these applicable RWA,
fractional, auction, or governance requirements.

### 4.2 M2 Backend trading

ArtFi's platform role is a trading intermediary. It records intent and discovers counterparties;
it does not gain authority over customer property. This architectural description is not a legal
licensing conclusion.

#### Authentication and orders

- Wallet-signature login uses a SIWE-style nonce challenge, JWT issue/refresh, persistent
  sessions, wallet-address binding, logout, and permission enforcement. Unauthenticated users
  cannot trade.
- Public marketplace discovery and opening the Xiongan Wallet test entry do not require
  login. Wallet assets, balances, holdings, and history require an authenticated session;
  connecting a wallet address or opening its page does not satisfy this requirement. Never
  expose a previous user's assets after logout, expiry, or an account change. This bounded
  test-entry exception does not disable production authentication or transaction approval.
- Support the existing limit and market order requirements for ERC-20 fractions: creation,
  amendment, cancellation, lifecycle states, and partial fills.
- An order is an EIP-712 signed intent with a maximum authorized quantity and stated terms.
  Amendment replaces the intent. Cancellation revokes it on chain.
- Fill consumption is cumulative on chain and keyed by the intent hash. Overfilling, replay of
  consumed authority, expired authority, and fills against revoked intent fail. Partial fills
  must remain possible without turning the signature into unlimited authority.
- Matching uses deterministic price-time priority and is replayable from the order log.
  Settlement carries the required parties' valid signatures and cannot execute unsigned terms.
- Positions and balances are read-only chain-event projections, reconcilable with the chain.
  Internal double-entry integrity does not create a custodial ledger or a property claim.
  For registry-backed assets, section 1.4 separately governs recorded holdership.
- Trade history unifies attributed chain and off-chain events and supports queries and filters.
- Admin APIs cover moderation, appeals, and platform configuration with durable audit records.
  They cannot move, arbitrarily freeze, or reassign user assets.
- Go APIs are versioned and documented in OpenAPI 3.1. Errors are bounded and reveal no secrets
  or internal topology.

#### Equal treatment of sellers

ArtCCH may sell its own holdings and intermediate third-party listings. These are disclosed
business roles, not technical privileges:

1. No seller allowlist or platform role restricts listing solely by seller identity. No
   administrative path can move ArtCCH holdings or customer holdings.
2. Matching is blind to seller identity; own-account orders receive no priority, latency,
   visibility, or fee advantage.
3. Seller disclosure and accounting distinguish own-account and third-party activity without
   branching the settlement path.

#### Signed settlement and auction escrow

For fixed-price and order-book trading, assets remain in their owners' wallets until the atomic
fill authorized by the applicable signed terms. Listing does not pull assets into resting escrow.
No fixed-price pooled balance is held between listing and settlement.

Auction escrow remains the existing scoped exception. The seller accepts the contract lock for
that auction, bounded by `startsAt` and `endsAt`; it gives the platform operator no discretionary
custody authority. Settlement and withdrawal of settled credits remain available during pause.
The seller must also have a permitted escape from an active escrowed listing during pause.
Apply the same rules to ArtCCH and other sellers.

A valid signed intent can authorize bounded partial fills; Stage 2 bounded authority can authorize
its specified executions. Do not replace these existing authorization models with an invented
manual re-signature requirement for every partial fill, and do not infer authority beyond them.

### 4.3 M3 Frontend

- Complete Class B surfaces against real M2 APIs and applicable M1 events.
- Provide the real auction workflow, trade and bid history, search, filters, sorting,
  pagination, notifications, and personal-center holdings and P&L where applicable.
- Provide the administrative console and the three clearly distinguished product sections.
- Support mobile web throughout. Preserve useful inherited interaction patterns and shared
  classes so approved visual updates do not require rebuilding functional flows.
- Keep chain, registry, custody/receipt, fraction, and digital-NFT meanings distinguishable in
  labels and actions. A generic wallet balance must not imply physical ownership or delivery.
- Retain eight languages: English, Simplified Chinese, Traditional Chinese, French, Spanish,
  German, Korean, and Japanese. English is authoritative for French, Spanish, German, Korean,
  and Japanese, without Chinese as an intermediate translation source.
- Use the approved translation module; `<LLM_PROVIDER_A>` may proofread and remains replaceable.
  Translation failure retains authoritative English rather than blank content or internal errors.

### 4.4 M4 DAO governance and administration

- The underlying ERC-721 remains in vault custody for membership under that vault model.
- Voting power uses `ERC20Votes` historical snapshots to prevent transfer-based double voting.
- Proposal threshold is at least 10% of historical voting supply.
- Approval thresholds remain greater than 50% for market migration, greater than 66.6667%
  for physical-action assistance, and greater than 80% for forced-buyout initiation.
- Forced-buyout initiation also requires the existing independent pricing evidence:
  T0–T-30 VWAP or the latest 10 actual trades.
- Support off-chain proposal drafting and display, on-chain vote, timelock queue, execution,
  and a public result.
- Automatic debit, forced liquidation, real buyout settlement, and unilateral ArtCCH voting
  control remain disabled in the current cycle.

These requirements implement the relevant asset model. Neither a digital charity NFT nor mere
possession of a receipt acquires fund-governance rights by analogy.

### 4.5 M5 Hardening and security

- Internal security review, penetration testing, code hardening, and remediation verification.
- The existing recognized third-party contract audit and its report/remediation artifacts
  remain part of the final audit scope. G3-A internal/simulated audit and G3-B third-party audit
  retain their existing separate placement; G3-B does not prevent development or stage testing.
- CI scans for secrets, private keys, raw signed transactions, and prohibited plaintext.
- Private keys and seed phrases never enter the ArtFi web application, API, databases,
  servers, GitHub, CI, or logs. Signing remains local. Raw signed transactions are not exposed
  through stdout, Git, CI, or ArtFi server storage.
- Preserve authentication, permission, balance validation, repeated-submission, replay,
  failure handling, and asset-access protections. Scope correction does not waive security.

### 4.6 M6 Operations

- CI/CD for staging and the approved deployment destinations.
- The existing production cluster scope: load balancing, MySQL primary/replica, backup,
  and restore.
- Application, host, and chain monitoring, aggregated logs, and alerting.
- Object storage validates MIME, size, and SHA-256, while maintaining charity master isolation.
- Runbooks and operator documentation appropriate to the delivered functions and final handover.

The existing topology keeps delivery and database operations in `<CLOUD_PROVIDER_A>` and
public-chain operations in the approved SIN execution zone in `<CLOUD_PROVIDER_B>`.
The operations agent's model interface uses replaceable `<LLM_PROVIDER_A>` capability; no
control path obtains transaction authority from model output.

These are scoped operations requirements, not a replacement G0 or a reason to require the entire
final production system before demonstrating a working section.

### 4.7 CH Charity NFT editions

CH.1–CH.11 preserve the existing charity business. Their itemization restored visibility to the
requirement ledger; it did not first introduce charity into ArtFi.

- **CH.1** The first fixed charity tranche is 13 works: `UNIT-A01/04/05/11/14/15/16/17/20/21/22/23/24`,
  counting the repeated A16 once. Each work is one ERC-1155 token ID with exactly 100 units,
  minted once with fixed supply. No additional-mint or external burn entry point exists.
  The formal historical set is 37 works, `UNIT-A01` and `UNIT-A03`–`UNIT-A38`; the 13-work
  tranche is contained in it, and neither includes withdrawn `UNIT-A02`.
- **CH.2** The recorded primary unit price is `0.01 ETH`. Edition trading uses the native
  ArtFi frontend and its OpenSea integration. ArtFi prepares and relays supported order
  operations; the user confirms the applicable wallet signature or transaction, and the
  venue/protocol executes and settles. OpenSea is primary, not exclusive. Preserve the
  edition's rights, beneficiary, release, and holder-access controls throughout this flow.
- **CH.3** Record sellout only when the distribution wallet balance is zero and external
  sale evidence is reconciled.
- **CH.4** Hash-record CCHS physical-donation acceptance only after sellout is recorded.
  This donation record does not give NFT holders a physical-asset claim.
- **CH.5** The only holder benefit is a high-resolution watermarked copy, released only
  after wallet ownership is verified.
- **CH.6** The unwatermarked master never enters public metadata, a website download,
  browser-delivered objects, or public storage.
- **CH.7** Public token metadata contains no artwork preview. A marketplace's missing-image
  treatment is not a reason to expose the master or add a preview contrary to this rule.
- **CH.8** Every display or offer discloses that the edition conveys no copyright, physical
  title, possession, redemption, commercial-use, or reproduction right.
- **CH.9** All primary proceeds are designated for CCHS and routed to its confirmed
  beneficiary wallet. Holders contact CCHS directly for any receipt. ArtFi issues no receipt,
  sets no eligible amount, and promises no tax credit. The existing valuation policy uses
  donation-date ETH/CAD fair market value from a CCHS-approved public source, retaining
  date, price, source, and snapshot hash, and fails closed without CCHS written confirmation.
- **CH.10** The real release package fails closed until the master, distinct watermarked
  holder file, rights evidence, CCHS status and receipting-policy evidence, nonzero beneficiary
  wallet, and listing eligibility are verified. `listingActionConfirmed` remains `false`;
  each external listing operation retains its existing action-time confirmation requirement.
- **CH.11** The master and watermarked holder file have different hashes, and the holder
  file is delivered without a browser preview.

The real-release evidence in `CHARITY_EDITIONS_PRECHAIN_EVIDENCE.md` remains applicable to
that release. Build and test the charity functions with isolated TEST_ONLY fixtures without
requiring real CCHS or ArtCCH documents as prerequisites. An isolated test must not claim a
real donation, tax receipt, or holder entitlement.

### 4.8 XM External marketplace integration and mirroring

XM.1–XM.6 cover both attributed event ingestion and the native OpenSea operational frontend.
The ingestion adapter remains passive. The application-side order workflow is active and
noncustodial. Neither boundary bans ArtFi's own whole-artwork or fractional trading.

- **XM.1** Provide native discovery, item/order details, listing creation, purchases,
  offers, offer acceptance, eligible cancellation, and result tracking through official
  supported OpenSea interfaces. ArtFi orchestrates user-approved requests without becoming
  the counterparty or holding private keys or assets. Wallets authorize signatures and
  transactions; the venue and protocol remain authoritative for execution and settlement.
- **XM.2** Use approved-source adapters with explicit backfill and realtime lifecycles,
  schema version, retained raw payload, source version, and an approved-source allowlist.
- **XM.3** Realtime events and REST gap-fill converge under duplication, out-of-order
  delivery, disconnect/reconnect, gaps, stale versions, sale after cancel, and stale listing
  after sale.
- **XM.4** APIs and screens retain the venue, chain, asset identity, order ID, event time,
  freshness, and source URL. NFT navigation, review, submission, and results remain within
  ArtFi; the external OpenSea website link is footer-only. Order review shows the precise
  asset and quantity, price/payment token, fees, expiry, chain, account, and action before
  wallet approval. A redirect, embedded OpenSea page, or passive feed does not satisfy this.
- **XM.5** Label fixtures, observed data, network, and freshness truthfully. Claim realtime
  only for a connected adapter with observation time and freshness. Never present a mainnet
  event as a testnet event.
- **XM.6** Preserve applicable transaction-result handling for `initiated`, `awaiting-wallet`,
  `submitted`, `accepted`, `rejected`, `pending`, `confirmed`, `failed`, and `cancelled`.
  Reconcile external state under retries, duplicate submissions, cancellation, reorgs,
  disconnects, account/network changes, and out-of-order callbacks. Distinguish signed,
  published, submitted, and chain-confirmed results. An off-chain order cancellation is
  reported only within the protocol's supported guarantees; it is not automatically final
  on-chain revocation. Never fabricate a transaction or success to exercise these states.

Retain compatible integration code and tests, including read-only event ingestion. Their
existence does not prove that every native operation is delivered. Keep API keys and
credential-bearing SDK calls server-side; return validated action data to the frontend for
user wallet confirmation. Apply the venue's current supported chains, protocol versions,
authentication, rate limits, and terms to the relevant adapter rather than assuming parity
with every feature of the OpenSea website. Missing credentials or capabilities fail closed
with a specific reason, without exposing secrets, fabricated assets, or substitute success.

Where a venue does not support Hoodi, report `unsupported-chain`
for the affected live venue operation; continue supported adapter, validation, recovery, error,
and non-write integration tests without invented data or unrelated blocks.

Native-flow verification covers browse/detail, list, buy, make/accept offer, and cancel using
isolated mocks or approved test assets, including rejection, expiry, stale order, duplicate
clicks, refresh, interrupted wallet approval, account/chain changes, and reconciliation. A
documentation update or a passing passive-mirror test does not establish operational delivery.

Official implementation references, checked 2026-10-04:

- [OpenSea NFT trading guide](https://docs.opensea.io/docs/buy-and-sell-nfts)
- [OpenSea TypeScript SDK](https://docs.opensea.io/reference/opensea-sdk)
- [Order cancellation and advanced use cases](https://github.com/ProjectOpenSea/opensea-sdk/blob/main/developerDocs/advanced-use-cases.md)

## 5. Nonfunctional requirements

| Dimension          | Existing requirement                                              |
| ------------------ | ----------------------------------------------------------------- |
| API latency        | p95 below 500 ms                                                  |
| Page load          | Below 3 seconds                                                   |
| Trade confirmation | Below 30 seconds excluding block confirmation                     |
| Wallet connection  | Below 2 seconds                                                   |
| Gas estimation     | Below 5 seconds                                                   |
| Concurrency        | At least 100 concurrent users and 50 concurrent trades            |
| Availability       | 48 continuous hours in the applicable final deployment acceptance |
| Accessibility      | Keyboard navigation, accessible names, and reduced-motion support |

Measure the functions and environments to which a requirement applies. Preserve NFR scope and
IDs; do not make a final-market soak or Stage 2 autonomous soak a new per-section handover gate.
A smaller functional delivery must not be reported as having passed an unrun load or soak test.

## 6. Networks and execution authority

- The development and integration write-testing chain is Hoodi, chain ID `560048`.
  Base Sepolia `84532` is superseded. The approved production chain remains a distinct decision.
- Verify functionality on the approved test chain wherever it does not inherently require
  mainnet. Do not defer ordinary wallet, contract, DAO, API, admin, UI, translation, metadata,
  access-control, security, or failure-path gaps by saying they will be tested on mainnet.
- Third-party test-chain limitations defer only the affected mainnet-only operation, not its
  adapter or the rest of the product.
- RPC, simulation, estimation, broadcast, and receipt checks use the existing approved
  non-sandbox SIN execution boundary.
- Preserve the separate G3-A internal/simulated audit, G3-B third-party audit, remediation,
  mainnet deployment, and go-live steps in their applicable phase.
- Mainnet, real-asset, and real-money operations follow the applicable written authority and
  execution safety rules. Passing a test or audit is evidence of a check, not by itself proof
  that the required execution authority has been obtained. This PRD does not grant it.

Historical documents contain inconsistent wording about automatic mainnet promotion versus
separate written approval. Record that conflict for the delivery owner; do not infer permission
from it or make it a prerequisite for the unrelated Hoodi and web-application delivery.

## 7. Test payload and historical charity records

### 7.1 Frozen Sepolia records

The historical charity set on Ethereum Sepolia, chain ID `11155111`, is a frozen record associated
with the original charity works: 37 works and 3,700 units. Its content and metadata hashes are not rewritten,
re-minted, or migrated to satisfy a current test. Historical verifiers remain pinned to their
actual chain.

The formal set is `UNIT-A01` and `UNIT-A03`–`UNIT-A38`, with 100 immutable ERC-1155 units per
work. Batch creation is atomic. The 13-work first tranche in CH.1 is not a competing total.

`UNIT-A02` is excluded from the formal set and all production/mainnet manifests. Its separately
recorded physical-asset/DAO fixture has exactly 100 test NFTs and a compliant preview in its own
test-only namespace. The formal batch rejects it.

Preserve the authoritative English inscription record: 15,254 bytes, LF, no BOM, SHA-256
`1c4e8260508e6f74c2e8bbd237e1f3d41f49d4c4ed7c7a0ca0f0df9162a66f01`.
Superseded hashes do not enter release artifacts. These are historical record constraints, not
instructions to manufacture or reissue that dataset.

The recorded initial price is `0.01 ETH` per NFT. Proceeds actually received by the issuer are
100% designated for CCHS. Purchase alone does not qualify the buyer for a donation receipt;
CCHS is the sole receipt issuer. NFT ownership creates no physical title, fractional physical
ownership, redemption, or delivery right.

### 7.2 Isolated Hoodi validation

The delivery side supplies a separately generated AI artwork payload for runtime testing on
Hoodi. It exercises applicable minting, atomic batch, vault, fractionalization, DAO, and market
paths without touching the frozen real record.

Every test asset is marked `TESTNET`, `NO REAL-WORLD VALUE`, and `NO LEGAL EFFECT` in token
metadata, the contract or series deployment description, relevant screens, and a top-level
batch-manifest field. These labels describe the isolated payload; they are not a general legal
opinion about blockchain transactions.

1. Use a separate namespace, never the historical charity release directory.
2. Use a separate contract deployment, never the Sepolia charity instance.
3. Do not use a real artist's name, signature, title, or style description, or an image easily
   confused with a real work.
4. Never include the test payload in a production or mainnet asset manifest.
5. Do not associate the test payload with real CCHS donation, receipt, valuation, or holder-benefit claims.

No CCHS or ArtCCH issued document is required to run this isolated technical payload. The real
charity release retains its separate evidence requirements. A test result proves only the path
actually exercised in its recorded environment.

### 7.3 Image and file boundaries

Use only separately generated, web-safe derivatives where the applicable asset model permits a
preview. Never expose an unwatermarked high-resolution master or its download path. Charity
public token metadata still has no artwork preview under CH.7, and the charity holder file still
has no browser preview under CH.11. A generic preview requirement cannot override those rules.

## 8. Stage 2 autonomous operation

The Stage 2 NO-HIL requirements incorporated by #110 remain in scope and are not silently removed
by the three-section clarification. Stage 2 is cumulative: it adds bounded autonomous execution
above Stage 1 and cannot bypass Stage 1 controls. Stage 1 delivery does not claim Stage 2 completion.

The incorporated #84 text retains the detailed A1–A10 capabilities, intent and attestation
schemas, authority layers, recovery requirements, A0–A6 acceptance gates, and metrics. The
following is a coordinated scope summary, not a replacement or narrowing of those details:

| Domain                        | Required responsibility                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1 Observe                    | Attributed and timestamped market, asset, chain, source, and system state; distinguish current, stale, unavailable, conflicting, and unverified observations |
| A2 Intent                     | Valid, bounded signed authority with quantity, price, exposure, execution, venue, counterparty, validity, nonce, and revocation limits                       |
| A3 Reason                     | Planning and explanation; model output remains advisory                                                                                                      |
| A4 Policy                     | Deterministic authority, financial, asset, Oracle, source, jurisdiction, counterparty, replay, nonce, rate, execution, and system checks                     |
| A5 Execute                    | Policy-compliant execution through the deterministic execution kernel                                                                                        |
| A6 Verify                     | Verifiable outcomes, receipts, and reconciliation; ambiguous results remain unknown until reconciled                                                         |
| A7 Recover                    | Deterministic recovery or safe degradation for normal operational incidents                                                                                  |
| A8 Learn                      | Learning within the existing authority and policy boundaries, without silent expansion                                                                       |
| A9 RWA grounding              | Approved evidence, pre-mint attestation, unique model-appropriate token binding, revocation, and asset restrictions                                          |
| A10 Constitutional governance | Separate DAO, multisignature, and timelock authority for constitutional changes                                                                              |

User authority, operational authority, and constitutional authority remain distinct. Operational
compromise must not grant unlimited asset control or authority to change source trust or protocol
rules. A restriction based on an approved asset authority is distinct from discretionary platform
administration and retains its applicable evidence, scope, and revocation requirements.

Stage 2 normal operations demonstrate observation, planning, policy, execution, verification,
reconciliation, recovery, and continuation without routine human repair. Out-of-bounds actions
are rejected, not used to expand authority. Constitutional changes keep their existing governance.
This product operating model does not authorize a development agent to bypass tool permissions or
execution approvals.

A0 architecture, A1 deterministic core, A2 bounded authority, A3 grounding, A4 recovery,
A5 continuous gray operation, and A6 NO-HIL soak are Stage 2 acceptance dimensions. Keep their
failure injection, test-only data, continuous-operation, and zero unauthorized-action metrics.
Do not convert A5 or A6 into a revived Stage 1 G0. A Stage 2 interface or invariant affects an
earlier stage only where the specific technical dependency is evidenced.

## 9. Product and infrastructure boundaries

ArtFi is the application layer. The existing integration relationship remains:

```text
ERC-8415 standard -> ERC8415-Kit -> Oracle -> ArtFi application
```

The independent wallet is a separate product. ArtFi implements and verifies the application-side
wallet and Oracle interfaces its actual workflows require. Neither the existence of legacy
wallet-extension code nor an ecosystem diagram imports every independent product milestone into
ArtFi's current handover.

The product is 8415 Wallet and Xiongan Wallet is its V2 tenant. Its assigned domain is
`xiongan.8415wallet.com`. ArtFi consumes a complete absolute deployment URL through the
server-only `ARTFI_XIONGAN_WALLET_URL` and no-store `/api/wallet-config` route; code supplies
no default hostname or port. The public entry may be opened without login during testing,
but assets, balances, holdings, and history remain unavailable until login. ArtFi and the
wallet must not imply a shared session or cross-origin signing capability that is not
implemented. Missing configuration and unavailable interfaces are reported truthfully.

Approved external registries, custodians, warehouses, and evidence providers are pluggable
sources, not ArtFi subsidiaries, exclusive dependencies, or universally authoritative sources.
Keep neutral placeholders for infrastructure and registry partners. CCHS and OpenSea identify
the client-specified business relationship and marketplace in section 1; their use here grants
no architectural privilege. Actual infrastructure bindings, when authorized, remain isolated in
`DEPLOYMENT_ENVIRONMENT.md` and removable without redesigning the application.

ArtFi does not imply discretionary portfolio management, investment advice, guaranteed value,
guaranteed liquidity or returns, credit underwriting, deposit-taking, or unauthorized key custody.
Real-world rights and commercial opening follow the applicable product model and authority.

## 10. Scope exclusions

The existing exclusions remain:

- Native mobile applications; responsive mobile web remains in scope.
- Chains beyond the approved EVM test chain and approved production counterpart.
- Automatic debit, forced liquidation, and real buyout settlement in the current cycle.
- Fiat on/off-ramp.
- Features without trace to the incorporated product baseline or an explicit later client instruction.

Do not use these exclusions to delete inherited fractional trading, DAO, charity, external-market
integration, applicable ERC-8415 RWA requirements, or unfinished work already within the baseline.
