# Emergency change directive — move the test chain to Hoodi

| Field      | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| Issued     | 2026-08-24                                                              |
| Priority   | Emergency — halts the current testnet track                             |
| Authority  | Latest explicit client requirement (`PRD.md` §0)                        |
| Supersedes | Base Sepolia `84532` as the write-test chain (`PRD.md` §6)              |
| Applies to | `GiraffeTechnology/ArtFi`, branch `claude/ci-all-pr-6dytk9` @ `47c9fe4` |
| Status     | **Blocked pending §2 decisions** — do not begin §4 until resolved       |

---

## 1. The change

The development and integration write-test chain moves from **Base Sepolia (`84532`)** to
**Hoodi**, an Ethereum testnet. Expected chain ID `560048`; this value is **not** to be
hardcoded from this document — attest chain ID and genesis through the approved SIN boundary
first, per `ACCEPTANCE.md` §4 G2.1, and use the attested value.

The Base Sepolia migration landed in commit `eddb87a` two commits ago. That work is reverted in
direction, not deleted: the same files change again, to a different target.

---

## 2. Conflicts this creates — record and resolve before implementing

`PRD.md` §0 requires that conflicting requirements be recorded, never silently resolved. Three
conflicts follow directly from this directive. Each needs a written client decision.

### 2.1 It removes the reason Base was chosen

Base Sepolia was selected on the stated grounds that _Sepolia cannot integrate with OpenSea and
production requires Base_. Hoodi is an Ethereum testnet. It does not restore OpenSea integration —
Hoodi is a validator- and staking-oriented network with materially less marketplace tooling than
Ethereum Sepolia, which is the chain the earlier decision rejected.

Consequence under `PRD.md` §7.1 and `ACCEPTANCE.md` §4 G2: external-marketplace discovery on Hoodi
will almost certainly record `unsupported-chain`. That disposition is permitted, but only the
marketplace's mainnet-only write action may be deferred — its adapter, mirror, validation, error
handling and non-write integration tests remain required on the test chain.

**Decision needed:** is OpenSea discovery on the test chain still an acceptance item, or is it
deferred to mainnet with the adapter tests remaining on Hoodi?

### 2.2 It changes the production target by implication

`PRD.md` §8 puts out of scope "chains other than the approved EVM test chain and its mainnet
counterpart". Hoodi's mainnet counterpart is Ethereum, not Base. Choosing Hoodi as the test chain
therefore reverses "production requires Base" and re-points M1's phase-P5 mainnet deployment at
Ethereum mainnet.

**Decision needed:** confirm the production chain. If production remains Base, testing on an
Ethereum testnet does not exercise the chain the product ships to, and G2 stops being evidence for
G4. If production moves to Ethereum, that is a scope change and must be recorded as one.

### 2.3 The toolchain does not ship Hoodi

Verified against the installed dependency, not assumed:

```
node_modules/.pnpm/viem@2.23.2_.../node_modules/viem/chains/definitions/
  baseSepolia.ts   holesky.ts   sepolia.ts     ← no hoodi.ts
```

viem 2.23.2 has no Hoodi definition, so wagmi cannot import one.

**Decision needed:** upgrade viem to a version that defines Hoodi, or declare the chain locally
with `defineChain`. Upgrading is preferable — a locally declared chain carries the RPC URL, block
explorer and multicall address as our own unreviewed constants. Note that viem is already on a
Dependabot track; an upgrade must not silently pull unrelated majors.

---

## 3. What must not change

**Release artifacts stay on Ethereum Sepolia.** `release/mint-batches/ye-yongrun-unit-a01-a38`
records a mint that actually occurred: transaction
`0xfe71d3af964bc58ca2f7c3dcef652e352929f3e1649959e9461b34a08fb0534b`, block `11545902`. The 37
minted tokens committed to metadata carrying `chainId 11155111`. Rewriting those files would leave
the record describing a chain the tokens were never minted on, which `ACCEPTANCE.md` §3 rules out
as evidence and §7.7 makes an audit failure.

Freeze that batch as superseded. Generate any Hoodi batch in a separate namespace. Regeneration
needs the master assets under `release/artworks`, which are correctly excluded from Git and are not
available in the CI or agent environment.

**Release verifiers stay pinned to `11_155_111`** for as long as they validate those artifacts.
A verifier must never report a chain it did not check — that defect was introduced during the Base
migration and fixed in `47c9fe4`; do not reintroduce it. Note the underscore literal form
`11_155_111`, which a naive search for `11155111` will miss.

---

## 4. Work items

Do not start until §2 is resolved. Ordered so that each step is verifiable before the next.

### 4.1 Chain definition

- [ ] Resolve §2.3. If upgrading viem, pin the exact version and confirm `hoodi` is exported.
- [ ] Attest Hoodi chain ID and genesis through the SIN boundary; record the attested value.

### 4.2 Runtime layer

- [ ] `apps/web/src/lib/wagmi.ts` — `supportedChain`, the `chains` array, and both transports.
      Environment variables become `NEXT_PUBLIC_HOODI_RPC_URL` and the external-market equivalent
      implied by the §2.2 decision.
- [ ] `apps/web/src/lib/wagmi.test.ts` — chain-ID assertions.
- [ ] `apps/web/src/app/api/health/route.ts` — reported `chainId`.
- [ ] `apps/api/internal/httpapi/rwa.go` — rename `baseSepoliaChainID` and its value; update every
      call site.
- [ ] `apps/api/internal/httpapi/handler.go`, `market.go`, `governance.go` — the `network` string.
- [ ] `apps/api/openapi/openapi.yaml` — every `const:` for `chainId` and `network`, then
      `pnpm api:generate`.
- [ ] `packages/api-client/src/index.ts` and `index.test.ts` — the literals openapi-typescript does
      not generate.

### 4.3 User-visible surfaces

- [ ] Block-explorer links in `rwa-create-flow.tsx`, `charity-edition-create-flow.tsx`,
      `nft-wallet-import.tsx`, `minted-nft-catalog.tsx` — Hoodi explorer base URL.
- [ ] Chain names in copy across `apps/web/src` and `apps/web/e2e`. The Base migration normalized
      these to "Base Sepolia"; search that exact string.
- [ ] `apps/api/internal/httpapi/handler_test.go` — the OpenSea discovery path embeds the chain
      slug and will fail if missed. It did during the Base migration.

### 4.4 Scripts

- [ ] `scripts/test/sepolia-preflight.sh`, `sepolia-standards-probe.sh`,
      `sepolia-charity-editions-probe.sh` — chain guard and failure message. Consider renaming the
      files; the chain name in the filename is now wrong twice over.
- [ ] `scripts/local/test-wallet.mjs` and its test — the chain restriction.
- [ ] `scripts/test/verify-sepolia-tooling.mjs` — the assertions that pin the preflight chain.
- [ ] Generator scripts under `scripts/release/` — only if §2 authorizes a Hoodi batch.

### 4.5 Documentation

- [ ] `PRD.md` §6 — the promotion path diagram and the write-test chain.
- [ ] `docs/` — seven files still name Ethereum Sepolia; four
      `packages/contracts/deployments/sepolia*.example.json` templates likewise.
- [ ] `STATUS.md` — record this directive and the §2 decisions.

---

## 5. Verification

A change of chain invalidates every runtime proof taken on the previous one. `ACCEPTANCE.md` §3
excludes "a test result from a different commit, branch, chain or contract".

- [ ] All 23 local quality gates green from a clean checkout on the delivery commit.
- [ ] `go vet`, `go test -race`, `gofmt` clean.
- [ ] Playwright and Axe green on desktop and mobile.
- [ ] One GitHub CI run on the exact delivery commit. This branch has never had one; three commits
      currently carry local evidence only, which §5 does not accept.
- [ ] G2 runtime items re-executed on Hoodi with recorded transaction hashes, receipts, blocks,
      events and balances. Nothing from Ethereum Sepolia carries over.

---

## 6. Standing blockers, unchanged by this directive

These predate the chain change and still gate delivery. They are listed so the chain migration is
not mistaken for progress against them.

| Item                                                                  | State                                            |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| M2 backend trading — 115 days, the largest line item                  | No implementation                                |
| M5 third-party security audit — USD 20,000 budget line                | Not engaged                                      |
| M6 operations — CD, cluster, replication, monitoring, alerting        | Not implemented                                  |
| Class B surfaces — auction, trade history, search, P&L, notifications | Mock or absent                                   |
| A01–A38 compliant previews                                            | Zero present; `ACCEPTANCE.md` §7.8 audit failure |
| `pics/*.png` and `fractional_steps/*`                                 | Absent; G1 cannot be signed off                  |
| Class A prototype artifacts named in `PRD.md` §2.1                    | Not present under those names                    |
| MySQL logical backup and restore in CI                                | Missing; `ACCEPTANCE.md` §5 mandates it          |

---

## 7. Recommendation

Resolve §2.2 first. It is the only one of the three that can invalidate the other two: if
production remains Base, this directive should be withdrawn rather than implemented, because a
test chain with no relationship to the production chain cannot satisfy G2 as the authorization for
G4. If production moves to Ethereum, the directive stands and §2.1 and §2.3 become ordinary
implementation questions.

Implementing before that decision risks a third chain migration.
