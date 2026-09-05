# ArtCCH:ArtFi — Evidence Snapshot

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Reviewed    | `fdb90ff` on `main` (PR #68)                                          |
| Base        | `da1b196`                                                             |
| Environment | local + GitHub CI. **No runtime chain evidence exists on any chain.** |
| Date        | 2026-08-30                                                            |
| Reviewer    | Claude (acting PM), on client instruction                             |
| Scope note  | ArtFi is a trading intermediary, not an exchange (`PRD.md` §4.2)      |

> **Attribution rule.** `Reviewed` names the commit the matrix below was assessed against, not its
> base — the rulings and rescopes recorded here do not exist at the base. Whoever merges a commit
> that changes a status value, a count, or an item's evidence stamps the merge SHA into `Reviewed`
> immediately after merging; a squash merge cannot do it in the merge commit itself, so it is the
> first follow-up commit. `ACCEPTANCE.md` §3 excludes evidence taken from a different commit, and
> that applies to this file describing itself.
>
> **Why the chain terminates.** The obligation covers the matrix, which is evidence about the
> codebase. This rule text and the change log are metadata about this file: changing them alters no
> item's status, count or evidence, so they carry no stamping obligation. Without that limit every
> stamp would need a stamp, forever.
>
> **A row cannot name its own merge.** A change-log row describing a change that lands with the pull
> request introducing it is keyed by that PR number, not a SHA — the SHA does not exist when the row
> is written, and inventing one attributes evidence to a commit that does not carry it. GitHub
> resolves the PR number to the merge commit permanently, so the reference stays auditable.

> This file records current evidence. It never upgrades evidence into delivery status.
> Statuses are the six values defined in `ACCEPTANCE.md` §2. Update on every delivery commit.
> Progress is counted in items, never in person-days (`ACCEPTANCE.md` §6.1).

---

## Headline

**`VERIFIED` 4 / 60.**

| Status                     | Count | Meaning here                                      |
| -------------------------- | ----: | ------------------------------------------------- |
| `VERIFIED`                 |     4 | Evidence exists on this commit and environment    |
| `IMPLEMENTED-NOT-VERIFIED` |    20 | **Code exists; only runtime evidence is missing** |
| `NOT-IMPLEMENTED`          |    34 | Behaviour absent                                  |
| `BLOCKED`                  |     1 | Client-side asset missing                         |
| `PENDING-GATE`             |     1 | Scheduled, awaiting a named gate                  |

The 20 `IMPLEMENTED-NOT-VERIFIED` items are the cheapest available progress: one execution of the
G2 runtime matrix on Hoodi converts them without writing a line of feature code.

---

## Module coverage

| Module             |  Items | `VERIFIED` | `IMPL-NOT-VER` | `NOT-IMPL` | Other            |
| ------------------ | -----: | ---------: | -------------: | ---------: | ---------------- |
| M1 Smart contracts |      8 |          0 |              7 |          1 |                  |
| M2 Backend trading |     11 |          0 |              2 |          9 |                  |
| M3 Frontend        |     10 |          0 |              2 |          7 | 1 `BLOCKED`      |
| M4 DAO governance  |      6 |          1 |              4 |          1 |                  |
| M5 Security        |      7 |          1 |              1 |          4 | 1 `PENDING-GATE` |
| M6 Operations      |      5 |          0 |              2 |          3 |                  |
| §5 Non-functional  |      8 |          1 |              0 |          7 |                  |
| §7 Validation data |      5 |          1 |              2 |          2 |                  |
| **Total**          | **60** |      **4** |         **20** |     **34** | **2**            |

---

## M1 — Smart contracts (`PRD.md` §4.1)

| #    | Requirement                           | Status                     | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1.1 | Auction: listing, bid, settle, refund | `IMPLEMENTED-NOT-VERIFIED` | `ArtFiMarket.sol`; `MarketGovernance.t.sol` preserves the PR #46 paused seller exit and covers fixed-price and auction settlement, pull refunds, cancellation, and ABI compatibility. Hoodi receipts remain required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M1.2 | Auction: reserve price                | `IMPLEMENTED-NOT-VERIFIED` | `packages/contracts/src/ArtFiMarket.sol`; `packages/contracts/test/MarketGovernance.t.sol::testAuctionReserveNotMetRefundsBidAndReturnsAsset`. Hoodi receipt remains required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M1.3 | Auction: minimum increment            | `IMPLEMENTED-NOT-VERIFIED` | `packages/contracts/src/ArtFiMarket.sol`; `packages/contracts/test/MarketGovernance.t.sol::{testAuctionMinimumIncrementRejectsBelowAndAcceptsExactBoundary,testFuzzAuctionMinimumIncrementBoundary}`. Hoodi receipt remains required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M1.4 | Auction: extension on late bid        | `IMPLEMENTED-NOT-VERIFIED` | `packages/contracts/src/ArtFiMarket.sol`; `packages/contracts/test/MarketGovernance.t.sol::{testLateBidExtendsAuctionAndOriginalEndCannotSettle,testLateBidExtensionOverflowFailsWithStableError,testLegacyAuctionLateBidExtendsAndOriginalEndCannotSettle}`. Hoodi receipt remains required                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M1.5 | Revenue distribution, claim-based     | `IMPLEMENTED-NOT-VERIFIED` | `packages/contracts/src/FractionalToken.sol`; `packages/contracts/src/RevenueDistributor.sol`; `packages/contracts/test/RevenueDistributor.t.sol::{testClaimsUseSnapshotBalancesAfterFractionsMove,testFeeOnTransferRevenueIsRejectedWithoutRoundCreation,testOutboundFeeRevenueRevertsClaimAndAccounting,testRoundingDustIsBoundedAndCannotBeSwept,testFuzzProRataClaimsNeverExceedRevenue,invariant_ClaimsNeverExceedFundedRevenue}`. Claim-based Hoodi runtime receipts remain required                                                                                                                                                                                                                                                         |
| M1.6 | Multi-signature administration        | `NOT-IMPLEMENTED`          | Parts exist, the requirement does not. `packages/contracts/src/ArtFiAdminSafe.sol` (on-chain confirmation, immutable owners/threshold/delay, threshold ≥ 2 and nonzero delay enforced in the constructor) and `AdminSafeDeploymentPolicy.sol`, covered by `test/AdminSafeDeploymentPolicy.t.sol` (9 tests, including acceptance of a genuine safe) — PR #70. The shared frontend proposal path `apps/web/src/lib/admin-safe.ts`, covered by `admin-safe.test.ts` (15 tests) — PR #71. **No privileged role is held by the safe on any deployment path, and no operator flow calls the proposal path**, so administration is still single-EOA end to end. Stays `NOT-IMPLEMENTED` until the three operator flows and the deploy-script binding land |
| M1.7 | Deployment tooling, address manifest  | `IMPLEMENTED-NOT-VERIFIED` | 6 Foundry scripts, Hoodi guard verified locally (`a3d6784`); preflight rejects zero and malformed addresses before any broadcast, and `DeployRevenueDistributor` probes the immutable fraction-token dependency (`test/DeployRevenueDistributorGuard.t.sol`, 3 tests). `DeployMarket` and `DeployRevenueDistributor` added behind default-off opt-ins (`fdb90ff`); the tooling verifier now asserts the defaults rather than asserting the market is undeployable. All manifests remain `*.example.json`                                                                                                                                                                                                                                           |
| M1.8 | Unit / fuzz / invariant / integration | `IMPLEMENTED-NOT-VERIFIED` | 70 Foundry tests pass (`forge test --offline --use /opt/solc-0.8.30`); see `packages/contracts/test/`. The revenue invariant targets only `RevenueInvariantHandler.fundAndClaim` and requires nonzero calls with zero reverts; `cancelListing` is covered by `testPauseDoesNotTrapEscrowedListing`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## M2 — Backend core trading (`PRD.md` §4.2)

| #     | Requirement                                   | Status                     | Evidence / gap                                                                                                                                           |
| ----- | --------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2.1  | SIWE nonce challenge                          | `IMPLEMENTED-NOT-VERIFIED` | `apps/web/src/lib/operator-auth.ts` — **operator only, not users**                                                                                       |
| M2.2  | JWT issue / refresh / session / logout        | `NOT-IMPLEMENTED`          | zero JWT references in `apps/api` or `apps/web/src`                                                                                                      |
| M2.3  | Wallet-address binding                        | `NOT-IMPLEMENTED`          |                                                                                                                                                          |
| M2.4  | Trading schema                                | `NOT-IMPLEMENTED`          | no `orders`, `trades`, `positions`, `sessions`, `users` table exists. Prerequisite for M2.5–M2.9. Per the intermediary ruling no custody ledger is built |
| M2.5  | Signed-intent orders: create / amend / cancel | `NOT-IMPLEMENTED`          | the only `orders` in Go are OpenSea mirror records. Orders are EIP-712 payloads the user signs                                                           |
| M2.6  | Order lifecycle, partial fills                | `NOT-IMPLEMENTED`          |                                                                                                                                                          |
| M2.7  | Matching engine, price-time, replayable       | `NOT-IMPLEMENTED`          | the only "matching" is a word in a test message. Output settles on chain with both signatures                                                            |
| M2.8  | Position projection from chain events         | `NOT-IMPLEMENTED`          | **Rescoped 2026-08-30**: the custodial double-entry ledger is not built. ArtFi is an intermediary; the chain is the ownership authority (`PRD.md` §4.2)  |
| M2.9  | Trade history service                         | `NOT-IMPLEMENTED`          |                                                                                                                                                          |
| M2.10 | Admin API with audit records                  | `NOT-IMPLEMENTED`          | no `/v1/admin` route. No admin action may move, freeze or reassign user assets                                                                           |
| M2.11 | OpenAPI 3.1, bounded errors                   | `IMPLEMENTED-NOT-VERIFIED` | `apps/api/openapi/openapi.yaml`, drift tested in CI                                                                                                      |

## M3 — Frontend (`PRD.md` §4.3)

| #     | Requirement                            | Status                     | Evidence / gap                                                                                               |
| ----- | -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M3.1  | Auction UI bound to M1 events          | `NOT-IMPLEMENTED`          | "auction" appears only as a DAO proposal label                                                               |
| M3.2  | Trade and bid history UI               | `NOT-IMPLEMENTED`          |                                                                                                              |
| M3.3  | Search / filter / sort / pagination    | `NOT-IMPLEMENTED`          | operates on a 3-element Go slice, `handler.go:68`. `ACCEPTANCE.md` §7.5 failure                              |
| M3.4  | Personal centre live positions and P&L | `NOT-IMPLEMENTED`          | no cost-basis or P&L computation                                                                             |
| M3.5  | Notifications                          | `NOT-IMPLEMENTED`          | `market.go:207` returns a permanently empty array                                                            |
| M3.6  | Admin console UI                       | `NOT-IMPLEMENTED`          | no `/admin` route in source; the public 404 is correct behaviour                                             |
| M3.7  | Real catalogue replaces fixtures       | `NOT-IMPLEMENTED`          | `lib/catalog.ts` holds 6 invented artworks by 6 invented artists; `UNIT-A` appears 0 times in `apps/web/src` |
| M3.8  | Mobile adaptation                      | `IMPLEMENTED-NOT-VERIFIED` | responsive CSS, mobile Playwright profile                                                                    |
| M3.9  | Eight-language support                 | `IMPLEMENTED-NOT-VERIFIED` | `language-provider.tsx`, 8 locales                                                                           |
| M3.10 | Class A visual parity vs `pics/*.png`  | `BLOCKED`                  | **`pics/` and `fractional_steps/` are absent. G1 cannot be signed off.** Client-side                         |

## M4 — DAO governance (`PRD.md` §4.4)

| #    | Requirement                                                | Status                     | Evidence / gap                                                          |
| ---- | ---------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| M4.1 | Vault custody persists for membership                      | `IMPLEMENTED-NOT-VERIFIED` | `ArtFiVault.sol`, invariant tests                                       |
| M4.2 | `ERC20Votes` historical snapshots                          | `IMPLEMENTED-NOT-VERIFIED` | `ArtFiGovernor.sol`                                                     |
| M4.3 | Proposal threshold ≥10%                                    | `IMPLEMENTED-NOT-VERIFIED` | fixed on-chain, tested                                                  |
| M4.4 | Thresholds >50% / >66.6667% / >80% + pricing evidence      | `IMPLEMENTED-NOT-VERIFIED` | selector-bound, strictly greater, tested                                |
| M4.5 | Draft → vote → queue → timelock → execute → result         | `NOT-IMPLEMENTED`          | no runtime execution on any chain                                       |
| M4.6 | Debit / liquidation / buyout / unilateral control disabled | `VERIFIED`                 | absent and testable as unavailable; `PRD.md` §4.4 requires exactly this |

## M5 — Security (`PRD.md` §4.5, amended by `DIRECTIVE_2026-08-30_DELIVERY.md` §1.1)

| #    | Requirement                                    | Status                     | Evidence / gap                                                                      |
| ---- | ---------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| M5.1 | Internal security review                       | `NOT-IMPLEMENTED`          |                                                                                     |
| M5.2 | Penetration test                               | `NOT-IMPLEMENTED`          |                                                                                     |
| M5.3 | Simulated audit report, per-finding PoC test   | `NOT-IMPLEMENTED`          | G3-A. First priority is `ArtFiMarket.sol`                                           |
| M5.4 | Hardening, remediation re-verified by test     | `NOT-IMPLEMENTED`          |                                                                                     |
| M5.5 | Third-party audit                              | `PENDING-GATE`             | G3-B, deferred to P5 by client ruling. Budget retained, not cancelled               |
| M5.6 | Secret / key / raw-tx / plaintext scans in CI  | `IMPLEMENTED-NOT-VERIFIED` | secret scan runs in CI; the prohibited plaintext-IP scan is not separately asserted |
| M5.7 | Keys never in Web / API / MySQL / servers / CI | `VERIFIED`                 | repository-wide scan clean over 315 files; no signing path exists                   |

## M6 — Operations (`PRD.md` §4.6)

| #    | Requirement                                      | Status                     | Evidence / gap                                                          |
| ---- | ------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------- |
| M6.1 | CI/CD to staging and production                  | `NOT-IMPLEMENTED`          | one workflow, `quality.yml`. No CD                                      |
| M6.2 | Cluster: load balancing, replica, backup/restore | `NOT-IMPLEMENTED`          | `ACCEPTANCE.md` §5 also mandates a CI backup/restore job that is absent |
| M6.3 | Monitoring, log aggregation, alerting            | `NOT-IMPLEMENTED`          |                                                                         |
| M6.4 | Object storage MIME / size / SHA-256 validation  | `IMPLEMENTED-NOT-VERIFIED` | `s3store.go`, `rwa.go`                                                  |
| M6.5 | Runbooks and operator documentation              | `IMPLEMENTED-NOT-VERIFIED` | `docs/OPERATIONS_RUNBOOK.md`; no observed drill                         |

## Non-functional (`PRD.md` §5)

| #     | Target                            | Status            | Evidence / gap                                               |
| ----- | --------------------------------- | ----------------- | ------------------------------------------------------------ |
| NFR.1 | API latency < 500 ms p95          | `NOT-IMPLEMENTED` | no measurement                                               |
| NFR.2 | Page load < 3 s                   | `NOT-IMPLEMENTED` | no measurement                                               |
| NFR.3 | Trade confirm < 30 s              | `NOT-IMPLEMENTED` | no measurement                                               |
| NFR.4 | Wallet connect < 2 s              | `NOT-IMPLEMENTED` | no measurement                                               |
| NFR.5 | Gas estimation < 5 s              | `NOT-IMPLEMENTED` | no measurement                                               |
| NFR.6 | 100+ users, 50+ concurrent trades | `NOT-IMPLEMENTED` | no load tooling: k6, artillery, autocannon, bench all absent |
| NFR.7 | 48 continuous hours stable        | `NOT-IMPLEMENTED` | no deployment to observe                                     |
| NFR.8 | Accessibility                     | `VERIFIED`        | Axe in CI, desktop and mobile, no serious findings           |

## Validation dataset (`PRD.md` §7, §7.0)

| #    | Item                                             | Status                     | Evidence / gap                                                                                                                                                    |
| ---- | ------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VD.1 | Sepolia 37-work batch, 100 each, 3,700 aggregate | `IMPLEMENTED-NOT-VERIFIED` | `sepolia-mint-evidence.json`: contract `0xec7d57e6…`, block `11545902`, 37 mint transactions. Recorded, not independently confirmed. **Frozen; does not migrate** |
| VD.2 | A02 excluded and hard-rejected                   | `IMPLEMENTED-NOT-VERIFIED` | generator excludes A02; withdrawn document returns 404                                                                                                            |
| VD.3 | Hoodi AI test payload                            | `NOT-IMPLEMENTED`          | authorized by `DIRECTIVE_2026-08-30_DELIVERY.md` §1.2.1; not yet generated                                                                                        |
| VD.4 | A01–A38 compliant previews                       | `NOT-IMPLEMENTED`          | **zero preview files exist.** `ACCEPTANCE.md` §7.8 makes this an audit failure                                                                                    |
| VD.5 | Inscription hash match                           | `VERIFIED`                 | `1c4e8260…66f01` matches `PRD.md` §7 and the generator constant                                                                                                   |

---

## Promotion gates

| Gate | Condition                      | Status            | Evidence                                           |
| ---- | ------------------------------ | ----------------- | -------------------------------------------------- |
| G1   | Prototype parity preserved     | `BLOCKED`         | `pics/` and `fractional_steps/` absent — see M3.10 |
| G2   | Functional completion on Hoodi | `NOT-IMPLEMENTED` | no runtime evidence on any chain for this commit   |
| G3-A | Simulated audit passed         | `NOT-IMPLEMENTED` | see M5.1–M5.4                                      |
| G3-B | Third-party audit passed       | `PENDING-GATE`    | deferred to P5; blocks mainnet only                |
| G4   | Mainnet authorization          | `PENDING-GATE`    | requires G1 + G2 + G3-A, then G3-B                 |

## Class B conversion (`PRD.md` §2.2 — "where the paid work concentrates")

| Surface         | Backed by real data? | Status            | Evidence        |
| --------------- | -------------------- | ----------------- | --------------- |
| Auction         | no                   | `NOT-IMPLEMENTED` | M1.1–M1.4, M3.1 |
| Trade history   | no                   | `NOT-IMPLEMENTED` | M2.9, M3.2      |
| Search / filter | no — 3 fixtures      | `NOT-IMPLEMENTED` | M3.3            |
| Personal centre | no                   | `NOT-IMPLEMENTED` | M3.4            |
| Notifications   | no — empty array     | `NOT-IMPLEMENTED` | M3.5            |

**0 of 5.**

## Class A regression (`PRD.md` §2.1 — preserve, not billable)

| Surface                        | Status                     | Note                                                                       |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------- |
| Wallet connection (RainbowKit) | `IMPLEMENTED-NOT-VERIFIED` | preserved — `providers.tsx`, `wallet-button.tsx`                           |
| RWA creation (3-step)          | `IMPLEMENTED-NOT-VERIFIED` | `rwa-create-flow.tsx`                                                      |
| DAO creation (4-step)          | `IMPLEMENTED-NOT-VERIFIED` | `dao-creation-flow.tsx`; nine `fractional_steps/` images unavailable       |
| Prototype contract stack       | `NOT-IMPLEMENTED`          | `NFTFactory`, `ERC721Vault`, `BasicNFT` absent — rebuilt under new names   |
| 12 prototype read-side APIs    | `NOT-IMPLEMENTED`          | none of the named routes exist                                             |
| Prototype MySQL schema         | `NOT-IMPLEMENTED`          | `RwaProjects`, `Rwas`, `Fractional`, `sys_users`, `sys_authorities` absent |
| Event monitor + DB sync        | `IMPLEMENTED-NOT-VERIFIED` | `persistence.go`, reorg handling, integration tests                        |

> Class A rows are recorded for regression tracking. `PRD.md` §2.1 states rebuilding these is out of
> scope and not billable; four rows show rebuild under different names rather than preservation.

---

## Open items

| #     | Item                                                | Owner        | Needed by     | Notes                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------- | ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~1~~ | ~~Confirm M2 matching-engine scope~~                | ~~Client~~   | —             | **Resolved 2026-08-30: ArtFi is a trading intermediary, not an exchange.** `PRD.md` §4.2. M2 unblocked                                                                                                                                                                                                            |
| 2     | Reconcile the schedule authorities                  | PM           | P1 exit       | `PRD.md` §3.1. Person-days retired as a unit by directive §1.3                                                                                                                                                                                                                                                    |
| 3     | Supply `pics/*.png` and `fractional_steps/*`        | Client       | G1            | Only `BLOCKED` item in the matrix                                                                                                                                                                                                                                                                                 |
| 4     | Hoodi RPC endpoint and funded keystore account      | Client       | G2            | SIN access already authorized                                                                                                                                                                                                                                                                                     |
| 5     | Production chain decision                           | Client       | before G4     | Undecided. Hoodi implies nothing                                                                                                                                                                                                                                                                                  |
| 6     | 13 token IDs / 1,300 units vs. 37 / 3,700 as minted | Client       | documentation | `PRD.md` §8.4 conflict; already on Sepolia                                                                                                                                                                                                                                                                        |
| ~~7~~ | ~~Settlement custody~~                              | ~~Client~~   | —             | **Resolved 2026-08-30: signature settlement.** Fixed-price and order-book settle by signature; escrow retained only for auctions (`PRD.md` §4.2.2)                                                                                                                                                                |
| ~~8~~ | ~~Pausing traps escrowed listings~~                 | ~~Delivery~~ | —             | **Resolved: `cancelListing` is no longer `whenNotPaused`.** Pausing froze a seller's escrowed asset, which `PRD.md` §4.2 forbids. Proven by `testPauseDoesNotTrapEscrowedListing`, which fails with `EnforcedPause()` before the fix; `testPauseStillBlocksNewListings` proves the pause still stops new activity |

---

## Change log

| Date       | Commit    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-31 | `78fa689` | M1.5 implemented: `RevenueDistributor.sol`, funded immutable rounds with pro-rata claims pulled against a past snapshot, and no sweep path — unclaimed revenue and rounding dust stay claimable indefinitely (`PRD.md` §4.2). `FractionalToken` gains `getPastBalance` on its own checkpoints, independent of delegated voting power. Reviewed as PR #49, landed here after #49's base stayed on its stacking branch. Suite 57 → 67                                                                                                                                                                                                                                                                                                     |
| 2026-08-31 | `efaa37b` | M1.2, M1.3 and M1.4 implemented: auction reserve price, minimum bid increment, and late-bid extension in `packages/contracts/src/ArtFiMarket.sol`, all with pull-based refunds. The PR #46 pause boundary is preserved. Suite 44 → 57                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-05 | `fdb90ff` | ArtFiMarket and RevenueDistributor deployment unlocked behind default-off opt-ins `ARTFI_DEPLOY_MARKET` and `ARTFI_DEPLOY_REVENUE_DISTRIBUTOR`. `verify-sepolia-tooling.mjs` previously asserted the literal `artfiMarketDeployed=false`, which made `ACCEPTANCE.md` §4 G2 item 3 unreachable and blocked every `IMPLEMENTED-NOT-VERIFIED` item from ever becoming `VERIFIED`. The guard is kept and widened: defaults must be off, no market or revenue setting may carry a repository default, and money-handling deployments must assert `TEST_ONLY_NO_REAL_VALUE` and a reviewed commit equal to a clean HEAD. No status value or count changes                                                                                     |
| 2026-09-05 | `#71`     | M1.6 evidence recorded for the first time. The row previously read "only matches are a code comment", which stopped being true when `ArtFiAdminSafe.sol` and `AdminSafeDeploymentPolicy.sol` landed in `e6e86b6` (PR #70) without a snapshot update; this row records that commit's contracts and this commit's `apps/web/src/lib/admin-safe.ts` shared proposal path together. Status stays `NOT-IMPLEMENTED`: no privileged role is bound to the safe and no operator flow proposes through it, so the requirement is absent end to end even though its parts compile and are tested. Counts unchanged (4 / 20 / 34 / 1 / 1). Raised by Codex as a P1 on this pull request — every delivery commit updates this file (`AGENTS.md` §2) |
| 2026-08-30 | `#46`     | `cancelListing` no longer gated on the pause. Pausing was the seller's only exit from a fixed-price listing with no bidder, so an administrative action could freeze a user's escrowed asset — prohibited by `PRD.md` §4.2 and `AGENTS.md` §3. Every other exit was already unpausable. Open item 8 closed; M1.8 evidence 42 -> 44 tests                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-08-30 | `#45`     | Attribution rule scoped to the matrix and given a termination clause, and change-log rows for a change landing with its own pull request keyed by PR number rather than a SHA that does not yet exist. Raised by Codex on `docs/STATUS.md`:223 — the previous draft credited `d7f2aca` with a clause that commit does not contain. No status value, count or item evidence changed                                                                                                                                                                                                                                                                                                                                                      |
| 2026-08-30 | `d7f2aca` | Stamped `7c25c13` into `Reviewed`. The two ruling rows below gained citations to their governing sections, replacing a bare commit SHA, which `ACCEPTANCE.md` §3 and `AGENTS.md` §2 do not accept as evidence (Codex P2 on `docs/STATUS.md`:218). No status value, count or item evidence changed                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-08-30 | `0a73fbf` | First filled snapshot. Baseline documents committed to the repository; the matrix was previously an unfilled template                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-08-30 | `7c25c13` | Client ruling: two business roles — 自营 and 中介 — under one set of rules (`docs/PRD.md` §4.2.1, `docs/DIRECTIVE_2026-08-30_DELIVERY.md` §1.4.1). ArtCCH's assets are treated as customer assets whose account belongs to ArtCCH; no seller allowlist, matching blind to seller identity, disclosure not privilege. Proof obligation added at `docs/ACCEPTANCE.md` §4 G2 (replay the order log with ArtCCH's and a third party's addresses exchanged); boundary restated at `AGENTS.md` §3. Corrects an earlier finding that called the open listing entry points a gap                                                                                                                                                                |
| 2026-08-30 | `4cb2937` | Client ruling: ArtFi is a trading intermediary, not an exchange (`docs/PRD.md` §4.2, `docs/DIRECTIVE_2026-08-30_DELIVERY.md` §1.4; settlement custody at `docs/PRD.md` §4.2.2). Open item 1 closed, M2 unblocked. M2.4/M2.5/M2.8 rescoped — no custody ledger; orders are signed intents; position projection replaces the custodial ledger. Item counts unchanged (60), only the character of M2.8. Settlement custody ruled: signature settlement, escrow only for auctions; open item 7 closed. Open item 8 added: pausing traps escrowed listings                                                                                                                                                                                   |
