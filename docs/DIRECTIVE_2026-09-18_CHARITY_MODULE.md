# Client directive — charity NFT editions and external-market mirroring are product modules

| Field     | Value                                                      |
| --------- | ---------------------------------------------------------- |
| Issued    | 2026-09-18                                                 |
| Issuer    | Client (ArtCCH)                                            |
| Authority | Explicit later client ruling (`AGENTS.md` §1, priority 2)  |
| Scope     | Requirement coverage for the charity and mirroring modules |
| Applies   | `GiraffeTechnology/ArtFi`, all branches                    |

Companion to `DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md`, which established charity NFT editions as
the third product line. This directive closes the coverage defect that ruling exposed.

---

## 1. The defect

Charity NFT editions were named as a product line, but the module appeared in **no requirement list
anywhere**:

| Source                       | Charity coverage before this directive                          |
| ---------------------------- | --------------------------------------------------------------- |
| Issue #84 (product baseline) | **No mention at all**                                           |
| `docs/PRD.md` §4             | No charity requirements; §4 ended at M6                         |
| `docs/PRD.md` §7             | Called the charity set "test payload… **not a product module**" |
| `docs/ACCEPTANCE.md`         | No charity audit instruction                                    |
| `docs/STATUS.md`             | **Zero charity rows** in a sixty-item matrix                    |

The product rules existed the whole time, in `docs/CHARITY_EDITIONS.md`. They were simply never
itemized, so the module could not be counted, audited, or reported as incomplete. A module that is
absent from the ledger reads as done.

### 1.1 The same defect on the mirroring side

The client identified **charity plus approved-external-marketplace mirroring as ArtFi's original
paired requirement**. The original PRD, `docs/PRD_CLAUDE_CODE_ACCEPTANCE.md` (`d754c6b`,
2026-08-20), carries both: `CHARITY-001`–`CHARITY-004` and `MARKET-001`–`MARKET-006`.

The mirroring side had the same gap. `apps/api` contains roughly 1,500 lines implementing it —
`external_market.go`, `opensea_discovery.go`, `market_orchestration.go` — and the matrix carried
**no row for any of it**. OpenSea appeared only as incidental evidence text inside `M2.5` and `M2.9`.

The original requirements are also **more specific than the derived ones**. Three corrections came
directly from reading `d754c6b`:

- `CHARITY-001` names **13 works** — `UNIT-A01/04/05/11/14/15/16/17/20/21/22/23/24`, a repeated
  `A16` counted once — where the derived rule said only "one artwork, one token ID". The set
  membership and the dedup rule **are not enforced**: the verifier matches `^UNIT-A\d{2}$` and
  checks neither. Open item 6's 13-versus-37 conflict stands.
- `CHARITY-002` additionally requires the master and holder files to **hash differently** and the
  holder file to be delivered **without a browser preview**. Recorded as `CH.11`.
- `CHARITY-003` locks receipt valuation to the donation-date `ETH/CAD` fair market value from a
  CCHS-approved public source, retaining date, price, source and snapshot hash. Folded into `CH.9`.

## 2. Ruling

**Charity NFT editions are a product module and are in delivery scope.** The omission is a defect,
corrected immediately.

## 3. Conflict recorded

`PRD.md` §0 requires the latest explicit written client requirement to control, with the conflict
recorded rather than silently resolved.

- **Superseded:** `PRD.md` §7 — "the charity artwork set is test payload used to exercise the
  platform, **not a product module**."
- **Controls:** this directive and `DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md` — charity NFT
  editions are the third product line and an independent business module.

What survives from §7 is narrower and still true: the historical 37-work charity batch on Ethereum
Sepolia is a **frozen record**, does not migrate, and is not the validation dataset. Runtime
validation uses the separately generated Hoodi AI payload.

## 4. What changed in the documents

- **`PRD.md` §4.7** — eleven requirements, `CH.1`–`CH.11`, itemizing rules already stated in
  `CHARITY_EDITIONS.md` and in the original `CHARITY-001`–`CHARITY-004`. No rule is new.
- **`PRD.md` §4.8** — six requirements, `XM.1`–`XM.6`, carrying the original `MARKET-001`–`MARKET-006`
  forward. No rule is new.
- **`PRD.md` §7** — the superseded sentence reproduced and marked, per §3.
- **`STATUS.md`** — a `CH` block of eleven rows and an `XM` block of six, each with current evidence.
  The matrix moves from sixty items to **seventy-seven**.
- **`ACCEPTANCE.md` §7** — audit instructions 16 and 17: a reachable master fails the audit, and so
  does presenting the holder benefit without the runtime behind it.

## 5. Counts

Adding rows records existing state; it promotes nothing.

| Status                     | Before |  After |
| -------------------------- | -----: | -----: |
| `VERIFIED`                 |      4 |      4 |
| `IMPLEMENTED-NOT-VERIFIED` |     20 |     34 |
| `NOT-IMPLEMENTED`          |     34 |     37 |
| `BLOCKED`                  |      1 |      1 |
| `PENDING-GATE`             |      1 |      1 |
| **Total**                  | **60** | **77** |

`VERIFIED` does not move. **The headline goes from 4 / 60 to 4 / 77 — the reported gap gets larger,
because it was previously understated by seventeen items.**

## 6. Where the module actually stands

Strongest at the bottom, absent at the top:

- **Contract layer — built.** `ArtFiCharityEditions.sol`, nine tests, deployment script and probe.
- **Release layer — built.** `verify-charity-edition-package.mjs` fails closed on master, watermarked
  holder file, rights, CCHS status, beneficiary wallet and listing eligibility.
- **Holder runtime — absent.** `CH.5`, `CH.6` and `CH.8` are `NOT-IMPLEMENTED`. There are no charity
  routes in `apps/api` and no charity route in `apps/web`. **What a buyer actually receives does not
  exist.**

**The mirroring side is more complete than a first pass suggested.** `apps/market-mirror` is a
separate workspace app carrying the OpenSea adapter: `opensea.ts` runs an `OpenSeaStreamClient` over
`ws` alongside a cursor-paged REST `backfill()`, and its tests run in CI. A first scoring of `XM.3`
and `XM.6` as `NOT-IMPLEMENTED` was wrong — it searched only `apps/api` and only Go string literals.
Both are `IMPLEMENTED-NOT-VERIFIED`. The lesson is recorded here because understating built work
wastes delivery-side time as surely as overstating it.

One narrow gap and one tension remain, both precise:

- **`XM.6` — `accepted` is declared but unreachable.** All nine states exist in
  `000007_external_trade_orchestration.up.sql`, `openapi.yaml` and the generated client, but no Go
  code ever writes `accepted`.
- **`XM.1` carries a recorded tension.** The original marks any deployable ArtFi-operated market
  implementation `P0 / FAIL`; `fdb90ff` made `ArtFiMarket.sol` deployable behind a default-off
  opt-in. Recorded rather than resolved.

## 7. What this directive does not change

- No code, contract, test or deployment tooling is modified by it.
- No requirement status is promoted; the ten new rows record current state only.
- The promotion gates G1–G4 are unchanged.
- Go-live still depends on the CCHS-side written evidence in
  `CHARITY_EDITIONS_PRECHAIN_EVIDENCE.md` under "Release blockers". Those gate **release, not
  implementation**: `CH.1`–`CH.10` are built and tested against TEST_ONLY fixtures without them.
- Issue #84 carries no charity requirement and is locked. **Issue #110 closes that gap**: it is the
  product baseline, incorporates #84 by reference, and carries the charity module at §2 and
  external-marketplace mirroring at §3. This directive remains the record of the ruling that
  produced them.
