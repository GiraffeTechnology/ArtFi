# Client directive — charity NFT editions are a product module

| Field     | Value                                                     |
| --------- | --------------------------------------------------------- |
| Issued    | 2026-09-18                                                |
| Issuer    | Client (ArtCCH)                                           |
| Authority | Explicit later client ruling (`AGENTS.md` §1, priority 2) |
| Scope     | Requirement coverage for the charity NFT module           |
| Applies   | `GiraffeTechnology/ArtFi`, all branches                   |

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

- **`PRD.md` §4.7** — ten requirements, `CH.1`–`CH.10`, each itemizing a rule already stated in
  `CHARITY_EDITIONS.md`. No rule is new.
- **`PRD.md` §7** — the superseded sentence reproduced and marked, per §3.
- **`STATUS.md`** — a `CH` block with all ten rows and their current evidence. The matrix moves from
  sixty items to **seventy**.
- **`ACCEPTANCE.md` §7** — audit instructions 16 and 17: a reachable master fails the audit, and so
  does presenting the holder benefit without the runtime behind it.

## 5. Counts

Adding rows records existing state; it promotes nothing.

| Status                     | Before |  After |
| -------------------------- | -----: | -----: |
| `VERIFIED`                 |      4 |      4 |
| `IMPLEMENTED-NOT-VERIFIED` |     20 |     27 |
| `NOT-IMPLEMENTED`          |     34 |     37 |
| `BLOCKED`                  |      1 |      1 |
| `PENDING-GATE`             |      1 |      1 |
| **Total**                  | **60** | **70** |

`VERIFIED` does not move. **The headline goes from 4 / 60 to 4 / 70 — the reported gap gets larger,
because it was previously understated by ten items.**

## 6. Where the module actually stands

Strongest at the bottom, absent at the top:

- **Contract layer — built.** `ArtFiCharityEditions.sol`, nine tests, deployment script and probe.
- **Release layer — built.** `verify-charity-edition-package.mjs` fails closed on master, watermarked
  holder file, rights, CCHS status, beneficiary wallet and listing eligibility.
- **Holder runtime — absent.** `CH.5`, `CH.6` and `CH.8` are `NOT-IMPLEMENTED`. There are no charity
  routes in `apps/api` and no charity route in `apps/web`. **What a buyer actually receives does not
  exist.**

## 7. What this directive does not change

- No code, contract, test or deployment tooling is modified by it.
- No requirement status is promoted; the ten new rows record current state only.
- The promotion gates G1–G4 are unchanged.
- Go-live still depends on the CCHS-side written evidence in
  `CHARITY_EDITIONS_PRECHAIN_EVIDENCE.md` under "Release blockers". Those gate **release, not
  implementation**: `CH.1`–`CH.10` are built and tested against TEST_ONLY fixtures without them.
- Issue #84 carries no charity requirement and is locked. Only the client can amend it. Until then
  the charity module traces to this directive and to `CHARITY_EDITIONS.md`, both priority 2 and
  below under `AGENTS.md` §1.
