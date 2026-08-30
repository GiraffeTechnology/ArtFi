# ArtCCH:ArtFi — Evidence Snapshot

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Reviewed    | `claude/ci-all-pr-6dytk9`, PR #42 head                                |
| Base        | `ac1ce8f` on `main`                                                   |
| Environment | local + GitHub CI. **No runtime chain evidence exists on any chain.** |
| Date        | 2026-08-30                                                            |
| Reviewer    | Claude (acting PM), on client instruction                             |
| Scope note  | ArtFi is a trading intermediary, not an exchange (`PRD.md` §4.2)      |

> **Attribution rule.** This snapshot describes the branch named above, not its base. The rulings
> and rescopes recorded here do not exist at `ac1ce8f`. Whoever merges stamps the merge SHA into
> `Reviewed` in the same commit — `ACCEPTANCE.md` §3 excludes evidence taken from a different
> commit, and that applies to this file describing itself.

> This file records current evidence. It never upgrades evidence into delivery status.
> Statuses are the six values defined in `ACCEPTANCE.md` §2. Update on every delivery commit.
> Progress is counted in items, never in person-days (`ACCEPTANCE.md` §6.1).

---

## Headline

**`VERIFIED` 4 / 60.**

| Status                     | Count | Meaning here                                      |
| -------------------------- | ----: | ------------------------------------------------- |
| `VERIFIED`                 |     4 | Evidence exists on this commit and environment    |
| `IMPLEMENTED-NOT-VERIFIED` |    16 | **Code exists; only runtime evidence is missing** |
| `NOT-IMPLEMENTED`          |    38 | Behaviour absent                                  |
| `BLOCKED`                  |     1 | Client-side asset missing                         |
| `PENDING-GATE`             |     1 | Scheduled, awaiting a named gate                  |

The 16 `IMPLEMENTED-NOT-VERIFIED` items are the cheapest available progress: one execution of the
G2 runtime matrix on Hoodi converts them without writing a line of feature code.

---

## Module coverage

| Module             |  Items | `VERIFIED` | `IMPL-NOT-VER` | `NOT-IMPL` | Other            |
| ------------------ | -----: | ---------: | -------------: | ---------: | ---------------- |
| M1 Smart contracts |      8 |          0 |              3 |          5 |                  |
| M2 Backend trading |     11 |          0 |              2 |          9 |                  |
| M3 Frontend        |     10 |          0 |              2 |          7 | 1 `BLOCKED`      |
| M4 DAO governance  |      6 |          1 |              4 |          1 |                  |
| M5 Security        |      7 |          1 |              1 |          4 | 1 `PENDING-GATE` |
| M6 Operations      |      5 |          0 |              2 |          3 |                  |
| §5 Non-functional  |      8 |          1 |              0 |          7 |                  |
| §7 Validation data |      5 |          1 |              2 |          2 |                  |
| **Total**          | **60** |      **4** |         **16** |     **38** | **2**            |

---

## M1 — Smart contracts (`PRD.md` §4.1)

| #    | Requirement                           | Status                     | Evidence / gap                                                                                                       |
| ---- | ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| M1.1 | Auction: listing, bid, settle, refund | `IMPLEMENTED-NOT-VERIFIED` | `ArtFiMarket.sol` 407 lines, `MarketGovernance.t.sol` 14 tests. Contract is inert — nothing deploys or references it |
| M1.2 | Auction: reserve price                | `NOT-IMPLEMENTED`          | zero occurrences of `reserve` in `ArtFiMarket.sol`                                                                   |
| M1.3 | Auction: minimum increment            | `NOT-IMPLEMENTED`          | zero occurrences                                                                                                     |
| M1.4 | Auction: extension on late bid        | `NOT-IMPLEMENTED`          | zero occurrences                                                                                                     |
| M1.5 | Revenue distribution, claim-based     | `NOT-IMPLEMENTED`          | only match is `distributionWallet`, a charity-contract field                                                         |
| M1.6 | Multi-signature administration        | `NOT-IMPLEMENTED`          | only matches are a code comment and `assembly ("memory-safe")`                                                       |
| M1.7 | Deployment tooling, address manifest  | `IMPLEMENTED-NOT-VERIFIED` | 4 Foundry scripts, Hoodi guard verified locally (`a3d6784`). All 4 manifests are `*.example.json`                    |
| M1.8 | Unit / fuzz / invariant / integration | `IMPLEMENTED-NOT-VERIFIED` | 42 Foundry tests pass. `ArtFiMarket.sol` is the least covered and the only money-handling contract                   |

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

| #     | Item                                                          | Owner      | Needed by      | Notes                                                                                                                                                                 |
| ----- | ------------------------------------------------------------- | ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~1~~ | ~~Confirm M2 matching-engine scope~~                          | ~~Client~~ | —              | **Resolved 2026-08-30: ArtFi is a trading intermediary, not an exchange.** `PRD.md` §4.2. M2 unblocked                                                                |
| 2     | Reconcile the schedule authorities                            | PM         | P1 exit        | `PRD.md` §3.1. Person-days retired as a unit by directive §1.3                                                                                                        |
| 3     | Supply `pics/*.png` and `fractional_steps/*`                  | Client     | G1             | Only `BLOCKED` item in the matrix                                                                                                                                     |
| 4     | Hoodi RPC endpoint and funded keystore account                | Client     | G2             | SIN access already authorized                                                                                                                                         |
| 5     | Production chain decision                                     | Client     | before G4      | Undecided. Hoodi implies nothing                                                                                                                                      |
| 6     | 13 token IDs / 1,300 units vs. 37 / 3,700 as minted           | Client     | documentation  | `PRD.md` §8.4 conflict; already on Sepolia                                                                                                                            |
| 7     | Settlement custody: signature settlement vs escrow throughout | Client     | before M2 code | `PRD.md` §4.2.1. A design decision recorded for reversal; does not block the other tracks                                                                             |
| 8     | **Pausing traps escrowed listings**                           | Delivery   | G3-A           | `cancelListing` is `whenNotPaused` and is the seller's only exit from an active listing. Fix required wherever escrow survives — the auction path under either option |

---

## Change log

| Date       | Commit    | Change                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-30 | `0a73fbf` | First filled snapshot. Baseline documents committed to the repository; the matrix was previously an unfilled template                                                                                                                                                                                                                                                                                                   |
| 2026-08-30 | PR #42    | Client ruling: ArtFi is a trading intermediary, not an exchange. Open item 1 closed, M2 unblocked. M2.4/M2.5/M2.8 rescoped — no custody ledger; orders are signed intents; position projection replaces the custodial ledger. Item counts unchanged (60), only the character of M2.8. Open items 7 and 8 added: the settlement-custody decision, and pausing traps escrowed listings. Stamp the merge SHA here on merge |
