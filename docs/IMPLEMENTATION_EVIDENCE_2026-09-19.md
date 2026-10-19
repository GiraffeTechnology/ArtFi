# Historical implementation evidence — 2026-09-19

Historical record: `463d67c`.
Historical source: the historical feature source, based on `main` at `c614994`.
The commit references and test results below identify their original source; they
are not current-head acceptance. Current product definitions are in `PRD.md`.


## 1. Historical product definitions

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
   carries no production build, deployment or go-live packaging (`PRD.md` §3.2.5).
4. **Holder authority.** For a registry-backed asset the **registry of record** is the holder
   authority and the chain is its projection; registries of record are a class, not a company;
   ArtFi treats ArtCCH as a third party and **operates no registry** (`PRD.md` §1.0.5).

One consequence worth stating because it changed an acceptance rule: mirroring **is** attributed
data plus a link out, so the deep link required by `PRD.md` §4.8 XM.4 stands. `ACCEPTANCE.md` §7.8
still reads that an external-marketplace redirect fails the audit; **on that one point §7.8
does not govern**. Every other item in §7.8 is untouched and still fails an audit. The historical annotation concerns that item only.

---

## 2. Implementation inventory

The following commits identify the historical implementation.

Historical merge-compatibility check: from shared base `fbca417`, this source
changed 17 files and PR #114 changed 7; their intersection was `docs/STATUS.md`.
`git merge-tree --write-tree` returned tree `d1c91d0` with no conflicted paths.
The merged status file retained both the M1/M2 and XM evidence rows. This is a
historical source-compatibility result, not a check of the current candidate.

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

- **CH.11** claimed the verifier asserted that the watermarked holder file hashes differently from
  the master, in a full mode CI never ran. **Both halves were wrong.** The manifest carried no
  holder-file field, so nothing was ever compared, and CI does run full mode through
  `pnpm charity-edition:verifier:test`. Corrected, and the packaging half now exists.
- **CH.10** claimed CI runs `--schema-only` so full mode is unexercised. Wrong for the same reason.
- **`PRD.md` §1** recorded the original PRD as a superseded position conflicting with the current
  venue ruling. Wrong — it describes the mirror-only phase correctly. Corrected per §1.2 above.

---


## 5. Technical clarifications and inputs

| Question                             | Resolution                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry-versus-chain divergence     | Not a tie. `PRD.md` §1.0.5 already gives each record a different question — registry answers who holds it, chain answers what settled. ArtFi reports both, substitutes neither, and answers neither from its own projection. Written out in §1.0.5 |
| Open item 6: 13 works versus 37      | Not a conflict. CH.1 says the **first** supply is 13; §8.4 says the **formal set** is 37. All 13 are inside the 37 and none is `UNIT-A02`. **13 is the first tranche of the 37.** Item 6 is closed                                                 |
| `ACCEPTANCE.md` §7.8's redirect item | Removed, not suspended. An audit item that forbids what a requirement mandates cannot be an audit condition. Every other exposure listed there still fails an audit                                                                                |

### Missing integration inputs

| Input                                                                  | Why it cannot be derived                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pics/*.png` and `fractional_steps/*`                                  | G1 compares against prototype screenshots that have never existed in this repository. M3.10 is the matrix's only `BLOCKED`, and it is blocked on an **asset**, not an opinion. The Figma work may replace this baseline entirely |
| An alert notification target and channel (open item 12)                | M6.3's promotion evidence is delivery of an alert **to a person**. A local fixture cannot supply a real channel                                                                                                                  |
| Test-chain RPC access | Runtime chain access was unavailable in this evidence environment |
| A descriptor store and a private object store for charity holder files | CH.5 runs end to end in code; no environment has either configured, so no holder has received a file anywhere                                                                                                                    |


## 6. Fixture disclosure evidence

- `prototype-data-notice.tsx` — a single disclosure component, rendered on `/`, `/projects`,
  `/projects/[slug]`, `/market/rwa/[slug]`, `/market/fractionals` and
  `/market/fractionals/[slug]`. `lib/catalog.ts` holds **six invented artworks by six invented
  artists**, with invented valuations and provenance, and until now no surface said so. The Development checks in `AGENTS.md`
  forbid presenting fixtures as live behaviour and `ACCEPTANCE.md` §7.7 fails an audit over it.
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

The browser suite used a locally installed Chromium through temporary configuration
because the expected Playwright/browser revisions did not match. Reproduce with
`pnpm test:e2e` and a matching browser install.

---


## 7. Whole-artwork settlement

**There are two markets, and the PRD says so.** `PRD.md` §1 lists the product lines and §1.0.1
gives them as two asset models. Model A, the full artwork asset receipt, is
`Artwork → Custody → Registry → ERC-8415 asset representation → Market transfer`, one token for one
artwork. Model B, the artwork investment fund, is the line §1.0.1 states "the ERC-721 mint, vault,
and ERC-20 fractionalization requirements in §4 implement" — `ArtFiRWA` into `ArtFiVault`, out as
`FractionalToken`, traded as ERC-20 in `ArtFiMarket.sol`. §3.2.3 carries the same split into the
stage table as `S-WA` and `S-FR`. **The split is stipulated, not derived here**, and earlier drafts
of this section cited §4.2.2 for it, which is the settlement rule, not the market split.

**The gap it closes — the ArtFi leg, not the first venue.** A whole artwork already trades. §1's
table gives its venues as **ArtFi + OpenSea**, and §4.8 XM.4 states that **OpenSea is a live venue
for every product line and a user must be able to reach it**. The historical product definition in §1.2 above sets out
two phases per line: until a line opens on ArtFi, ArtFi mirrors that line only; once it opens,
ArtFi also trades, settled by signature. The mirror half is built (`S-XM`). What was missing was
the **ArtFi-side settlement leg** — `ArtFiMarket` trades `IERC20` asset tokens only, which is the
fractions line — so the whole artwork had no way to settle _on ArtFi_. That historical phase definition is explicit that
a line's trading surface is built, tested and counted before it opens, which is what this is.

An earlier draft of this section said the whole artwork had no venue at all. That was wrong and is
corrected here: it has had one throughout.

**The settlement shape is not a choice made here either.** `PRD.md` §4.2.2 (client ruling
2026-08-30) already ruled that the non-auction path settles by signature: no pull at listing time,
both sides pulled at fill time, no resting balance. `AGENTS.md` §1.2 states the same settlement
boundary. Escrow is retained for auctions only, which is why `ArtFiMarket` is **not** modified.

**One reading is recorded in the contract header as correctable** rather than settled: the asset leg is written against the minimal ERC-721 surface (`ownerOf`,
`isApprovedForAll`, `safeTransferFrom`), with the collection carried in the signed intent rather
than fixed as a constant. ERC-8415 governs asset identity, registry synchronization, ownership
workflows and lifecycle (invariant 3); whether the whole artwork's token as deployed already
exposes that transfer surface is a conformance question about the token, not about this contract.
If it does, this works unchanged; if it does not, only the transfer leg needs an adapter — the
intent, the signature scheme, the revocation model and the UI do not depend on the choice.

A related observation, recorded and not acted on: the term ERC-8415 appears in this repository only
in documentation and comments, never in a contract. That is a conformance question for the
whole-artwork token to answer against the standard, which is not available in this environment. It
is **not** a claim that the line lacks an asset or a venue — it has both.

**A conflict that was found here and has since been closed.** The same ruling says `_pullExact` is
removed from the fixed-price path. `ArtFiMarket._createListing` was still calling it for
`FixedPrice` as well as `Auction`, and `buyFixed` still credited the seller into `credits[...]`, so
the fractions fixed-price path escrowed and held a resting balance — which §4.2.2 forbids. It was
first recorded here as a finding to be taken separately; it was then taken. See §7.3.

**The wire format is locked across the two implementations.** One fixed intent, domain and digest
(`0x29a4bedd…`) is asserted in both `WholeArtworkMarket.t.sol::testDigestMatchesTheBrowserSigner`
and `whole-artwork-intent.test.ts`. A renamed field, a reordered struct or a changed domain string
fails a test on both sides rather than producing signatures the market rejects at fill time. Do not
"fix" a drift by editing one side.

### Runtime configuration still missing

1. **Deployment on Hoodi.** `DeployWholeArtworkMarket.s.sol` is Hoodi-gated and reads
   `ARTFI_ADMIN`, `ARTFI_PAUSER`, `ARTFI_TOKEN_MANAGER`. It deploys with no collection and no
   payment token allowed, so a fresh deployment can settle nothing until the token manager opens
   one. No chain execution was performed in this evidence environment.
2. **`NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS`**, plus the artwork's own contract address
   and token id reaching the asset page. Until both are present the panel renders its
   unconfigured branch by design and offers no control.
3. **A real catalogue.** `lib/catalog.ts` is still six invented artworks with no on-chain identity
   (M3.7). Every asset page therefore shows the unconfigured branch today.
4. **A token-manager decision on which collection to open**, which is what the allowlist is for: a
   fresh deployment allows none, so opening one is an explicit act rather than a default.

Items 2, 3 and 4 are why this is **not** a stage handover: no user can yet carry the function out end
to end, so `PRD.md` §3.2.1 is not met and nothing in `STATUS.md` moves. The path is built, tested
and counted, which §3.2.6 is explicit is not the same as opened.

### One retired claim removed from the UI

The asset page read "Minting unlocks in Stage 2" and "Trading unlocks in Stage 4". That ladder is
`docs/ROADMAP.md`; the strings `Stage 1`–`Stage 4` appear nowhere
in `PRD.md`, and §3.2.6 states that stage order is not a gate. Adding a signing surface also made
the neighbouring "never requests a transaction or signature" false on that page. The fractional
page keeps an accurate version: the fraction market exists on chain and no screen reaches it
(M3.1). `whole-artwork-listing.spec.ts` fails if either phrasing returns.

## 7.3 The fractions market now settles fixed price by signature

The second of the two markets, `PRD.md` §1.0.1 model B, stage `S-FR`. It
touches nothing the charity run uses.

**What was wrong.** `PRD.md` §4.2.2, client ruling 2026-08-30, is explicit: "the fixed-price and
order-book path settles by signature — assets remain in the owner's wallet and move only in the
atomic fill the owner signed. `_pullExact` on listing is removed from that path; the market
contract pulls from both parties at fill time and never holds a resting balance." The shipped
contract did the opposite on that path: `_createListing` pulled the seller's tokens in for
`FixedPrice` as well as `Auction`, and `buyFixed` credited proceeds to `credits[...]` until
withdrawn. Both stated consequences of the ruling were false in code — the path held assets at
rest, and a seller could not keep the same tokens authorized in two places because the first
listing had already taken them.

**What changed.** `ArtFiMarket` now carries an EIP-712 `SaleIntent`. `fillIntent` verifies the
seller's signature and moves payment buyer-to-seller and fractions seller-to-buyer in one
transaction, with the contract on neither side and no credit entry. Partial fills follow §4.2:
`intentFilled[digest]` accumulates, a fill past the signed maximum reverts whole rather than being
clipped, and an exhausted or revoked authorization cannot be filled again. Sellers revoke on chain,
one intent at a time or in bulk by epoch, and both work while the market is paused — an
administrative pause must not keep a live claim on someone's tokens alive. Signatures go through
`SignatureChecker`, so a contract wallet authorizes over EIP-1271 on the same path as an EOA.

`createListing` now rejects `ListingKind.FixedPrice` with `FixedPriceSettlesBySignature`. Leaving
the escrowing path reachable would have kept the contradiction the ruling closed. The enum value is
retained so `Auction` keeps its ordinal and the `listings` getter stays ABI-compatible.

**What deliberately did not change.** §4.2.2 **retains escrow for auctions**, so
`createAuctionListing`, `placeBid`, `settleAuction`, `cancelListing`, the offering path and the
credit ledger they use are untouched. PR #46's property — a pause must never trap a seller's
escrowed asset — now rides on the auction path, which is the only one that still escrows;
`testPauseDoesNotTrapEscrowedListing` keeps its name and proves it there.

**Evidence.** `forge test`: 135 pass, 0 fail (114 before, 21 added in `FractionSaleIntent.t.sol`).
Negative assertions checked by mutation: removing the cumulative cap fails exactly the two overfill
tests and both revocation tests; removing the signature check fails exactly the forged-signature
and altered-terms tests; removing the `FixedPriceSettlesBySignature` guard fails exactly the two
tests that assert the escrow path is closed.

**`STATUS.md` moved nothing.** M2.5 and M2.6 stay `NOT-IMPLEMENTED`; their evidence now records
that the on-chain half exists while no backend stores or amends an intent and no screen reaches
either. M1.1 and M1.8 evidence text was corrected for the test count and for where the PR #46
property now lives.

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

---


## 9. Check summary

| Lane                        | State                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Whole artwork `S-WA` (§7) | Contract, browser signer, asset-page surface, Hoodi deploy script. 23 Foundry tests, 19 vitest, 6 Playwright           |
| Fractions `S-FR` (§7.3)     | Fixed-price path moved to signature settlement, escrow closed on that path and retained for auctions. 21 Foundry tests |
| Charity `S-CH` (`TESTPLAN_HOODI_CHARITY.md`)       | Deployment-and-test requirements written. **Not executed.**                                                   |

`forge test` 135 pass · `vitest run src` 125 pass across 11 files · `tsc --noEmit`, `eslint .`,
`forge fmt --check`, `forge lint`, `prettier --check .`, `check-secrets.mjs`,
`verify-chain-consistency.mjs` (18 layers, Hoodi 560048) and `contracts:deploy-tooling:check` all
clean at the tip.

Negative assertions in both new suites were checked by mutation rather than assumed: each deletion
of a guard fails exactly the tests that name it, and no others. The specific mutations are listed in
the commit messages for `8a39400` and `e26270d`.

### 9.2 What `docs/STATUS.md` says, and does not

**No status value moved in any of this.** `VERIFIED` is where it was. M2.5 and M2.6 stay
`NOT-IMPLEMENTED` with evidence noting that the on-chain half now exists while no backend stores or
amends an intent and no screen reaches either. Promotion is a separate decision against a reviewed
commit with runtime evidence, per `ACCEPTANCE.md` §3 — it is not implied by any of this.


### Toolchain reproduction note

Foundry is not preinstalled in the test environment and `foundryup` fails here: the proxy
returns 403 on its attestation download. The release tarball itself works —
`https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz`
extracts a usable `forge`. Run `forge fmt` **from `packages/contracts`**, never from the repository
root: the root has no `foundry.toml`, so the default 120-column width reflows files that
`contracts:format:check` then rejects at the configured 100.
