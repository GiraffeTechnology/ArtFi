# Emergency change directive — move the test chain to Hoodi

| Field      | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| Issued     | 2026-08-24                                                              |
| Priority   | Emergency — halts the current testnet track                             |
| Authority  | Latest explicit client requirement (`PRD.md` §0)                        |
| Supersedes | Base Sepolia `84532` as the write-test chain (`PRD.md` §6)              |
| Applies to | `GiraffeTechnology/ArtFi`, branch `claude/ci-all-pr-6dytk9` @ `47c9fe4` |
| Status     | **Ruled and implemented** — see §0 and §4                               |

---

## 0. Client ruling — 2026-08-24

The conflicts in §2 were put to the client and answered:

> Multiple versions have caused conflict. This confirmation controls: **test on Hoodi as the first
> choice. Select an alternative only where capability is insufficient.**

This ruling is the operative authority. §2 is retained as the recorded conflict history required by
`PRD.md` §0, not as an open question.

### 0.1 Fallback ladder

"Capability insufficient" is a finding, not a preference. Falling back requires evidence recorded
against the specific capability that failed, and the fallback applies only to that capability — not
to the chain as a whole.

| Order | Option                  | Permitted when                                                                                                                                                                            |
| ----- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Hoodi `560048`          | Default. Everything runs here unless a capability is proven absent.                                                                                                                       |
| 2     | Capability-scoped defer | One capability is unavailable on Hoodi. Record `unsupported-chain`, defer only that capability's write action, keep its adapter, validation, error-handling and non-write tests on Hoodi. |
| 3     | Alternative chain       | Hoodi cannot host the runtime tests at all. Requires a written scope change naming the replacement and its mainnet counterpart.                                                           |

Order 3 is not available for a capability that merely lacks third-party support. It applies only
where the chain itself cannot execute the contract suite.

### 0.2 Capability findings

| Capability           | Finding                                                                                                                                                                    | Disposition                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Chain definition     | `viem@2.55.18`, already installed and resolved by `wagmi@2.17.5`, exports `hoodi` with id `560048`, explorer `hoodi.etherscan.io`, and multicall3 at the canonical address | Order 1 — no fallback, no upgrade needed           |
| Contract runtime     | Hoodi is a full Ethereum execution-layer testnet; the suite is standard Solidity with no chain-specific opcodes                                                            | Order 1                                            |
| External marketplace | Not yet probed. OpenSea support on Hoodi is unlikely                                                                                                                       | Order 2 if the probe returns no support — see §2.1 |

§2.3 is closed: the toolchain constraint recorded there was measured against `viem@2.23.2`, a
transitive copy. The version this workspace actually resolves ships Hoodi.

---

## 1. The change

The development and integration write-test chain moves from **Base Sepolia (`84532`)** to
**Hoodi**, chain ID **`560048`**, an Ethereum testnet. The id is taken from the viem chain
definition rather than from prose; it must still be attested against genesis through the approved
SIN boundary before any write, per `ACCEPTANCE.md` §4 G2.1.

The Base Sepolia migration landed in commit `eddb87a`. That work is reverted in direction, not
deleted: the same files change again, to a different target.

---

## 2. Recorded conflicts

`PRD.md` §0 requires that conflicting requirements be recorded, never silently resolved. These
three conflicts were raised before implementation and resolved by the §0 ruling. They are kept
here as history; §2.1 and §2.2 carry residual items noted inline.

### 2.1 It removes the reason Base was chosen

Base Sepolia was selected on the stated grounds that _Sepolia cannot integrate with OpenSea and
production requires Base_. Hoodi is an Ethereum testnet. It does not restore OpenSea integration —
Hoodi is a validator- and staking-oriented network with materially less marketplace tooling than
Ethereum Sepolia, which is the chain the earlier decision rejected.

Consequence under `PRD.md` §7.1 and `ACCEPTANCE.md` §4 G2: external-marketplace discovery on Hoodi
will almost certainly record `unsupported-chain`. That disposition is permitted, but only the
marketplace's mainnet-only write action may be deferred — its adapter, mirror, validation, error
handling and non-write integration tests remain required on the test chain.

**Resolved by §0.** Probe OpenSea from the SIN boundary on Hoodi. If it returns no support,
that is fallback order 2: record `unsupported-chain`, defer only the marketplace write action, and
keep the adapter, mirror, validation and error-handling tests on Hoodi. Do not substitute evidence
from another chain.

**Residual:** the probe has not been run. Until it has, marketplace discovery is
`IMPLEMENTED-NOT-VERIFIED`, not deferred.

### 2.2 It changes the production target by implication

`PRD.md` §8 puts out of scope "chains other than the approved EVM test chain and its mainnet
counterpart". Hoodi's mainnet counterpart is Ethereum, not Base. Choosing Hoodi as the test chain
therefore reverses "production requires Base" and re-points M1's phase-P5 mainnet deployment at
Ethereum mainnet.

**Partially resolved by §0.** The ruling settles the test chain. It does not name the production
chain, and this directive does not infer one: `externalMarketChain` therefore stays on Ethereum
mainnet, which is Hoodi's counterpart, rather than being moved silently.

**Residual — still open:** confirm the production chain in writing. If it remains Base, G2 on an
Ethereum testnet does not authorize G4 on Base, and `PRD.md` §6 and §8 need amending. This is a
scope question and cannot be closed by implementation.

### 2.3 The toolchain does not ship Hoodi

Verified against the installed dependency, not assumed:

```
node_modules/.pnpm/viem@2.23.2_.../node_modules/viem/chains/definitions/
  baseSepolia.ts   holesky.ts   sepolia.ts     ← no hoodi.ts
```

viem 2.23.2 has no Hoodi definition, so wagmi cannot import one.

**Closed — the constraint was measured wrong.** `2.23.2` is a transitive copy left in the store.
`apps/web` declares `viem@2.55.18`, and `wagmi@2.17.5` resolves to that same copy, which does ship
`chains/definitions/hoodi.ts`. No upgrade and no local `defineChain` are required.

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

Sections 4.2 through 4.4 are **implemented**; 4.1 and 4.5 carry the remaining items.

### 4.1 Chain definition

- [x] §2.3 resolved — `viem@2.55.18` already exports `hoodi`; no dependency change made.
- [ ] Attest Hoodi chain ID and genesis through the SIN boundary; record the attested value.
- [ ] Probe OpenSea supported-chain list on Hoodi and record the result per §0.1 order 2.

### 4.2 Runtime layer

- [x] `apps/web/src/lib/wagmi.ts` — `supportedChain`, the `chains` array, and both transports.
      Environment variables become `NEXT_PUBLIC_HOODI_RPC_URL` and the external-market equivalent
      implied by the §2.2 decision.
- [x] `apps/web/src/lib/wagmi.test.ts` — chain-ID assertions.
- [x] `apps/web/src/app/api/health/route.ts` — reported `chainId`.
- [x] `apps/api/internal/httpapi/rwa.go` — rename `baseSepoliaChainID` and its value; update every
      call site.
- [x] `apps/api/internal/httpapi/handler.go`, `market.go`, `governance.go` — the `network` string.
- [x] `apps/api/openapi/openapi.yaml` — every `const:` for `chainId` and `network`, then
      `pnpm api:generate`.
- [x] `packages/api-client/src/index.ts` and `index.test.ts` — the literals openapi-typescript does
      not generate.

### 4.3 User-visible surfaces

- [x] Block-explorer links in `rwa-create-flow.tsx`, `charity-edition-create-flow.tsx`,
      `nft-wallet-import.tsx`, `minted-nft-catalog.tsx` — Hoodi explorer base URL.
- [x] Chain names in copy across `apps/web/src` and `apps/web/e2e`. The Base migration normalized
      these to "Base Sepolia"; search that exact string.
- [x] `apps/api/internal/httpapi/handler_test.go` — the OpenSea discovery path embeds the chain
      slug and will fail if missed. It did during the Base migration.

### 4.4 Scripts

- [x] `scripts/test/sepolia-preflight.sh`, `sepolia-standards-probe.sh`,
      `sepolia-charity-editions-probe.sh` — chain guard and failure message. Consider renaming the
      files; the chain name in the filename is now wrong twice over.
- [x] `scripts/local/test-wallet.mjs` and its test — the chain restriction.
- [x] `scripts/test/verify-sepolia-tooling.mjs` — the assertions that pin the preflight chain.
- [x] Generator scripts under `scripts/release/` — chain and metadata base path now target Hoodi; they run only when §3 authorises a batch. — only if §2 authorizes a Hoodi batch.

### 4.5 Documentation

- [ ] `PRD.md` §6 — the promotion path diagram and the write-test chain.
- [ ] `docs/` — seven files still name Ethereum Sepolia; four
      `packages/contracts/deployments/sepolia*.example.json` templates likewise.
- [ ] `STATUS.md` — record this directive and the §2 decisions.

---

## 5. Verification

A change of chain invalidates every runtime proof taken on the previous one. `ACCEPTANCE.md` §3
excludes "a test result from a different commit, branch, chain or contract".

- [x] All 23 local quality gates green on the migrated tree.
- [x] `go vet`, `go test -race`, `gofmt` clean.
- [x] Playwright and Axe green on desktop and mobile — 38 checks.
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
