# ArtFi agent instructions

Read this before touching the repository. It is short on purpose.

## 1. The governing documents

Three documents govern, in this order. Do not merge them and do not treat any other file as the
baseline.

| Document             | Answers                                       | You must                                     |
| -------------------- | --------------------------------------------- | -------------------------------------------- |
| `docs/PRD.md`        | What must exist and how it must behave        | Trace every change to a requirement in §4    |
| `docs/ACCEPTANCE.md` | What proves it exists, and how it is promoted | Report every item using its §2 status values |
| `docs/STATUS.md`     | Where each item stands right now              | **Update it on every delivery commit**       |

Client directives override all three where they conflict, newest first:

- `docs/DIRECTIVE_2026-08-30_DELIVERY.md` — measurement, the G3 split, Hoodi test payload
- `docs/DIRECTIVE_2026-08-24_HOODI.md` — the test chain

`docs/ROADMAP.md`, `docs/PRD_TRACEABILITY.md` and `docs/PRD_CLAUDE_CODE_ACCEPTANCE.md` predate this
set. Consult them for history; do not accept them as the current baseline.

## 2. Standing rules

**Evidence.** `ACCEPTANCE.md` §3 lists what is not evidence. The short version: your own assessment
of your own output is not evidence. Every claim cites a file path, a test name, a CI run, or a
transaction hash with its receipt.

**Status.** Use only the six values in `ACCEPTANCE.md` §2. Never mark deferred work `OUT-OF-SCOPE` —
that silently deletes paid scope. Work awaiting a named gate is `PENDING-GATE`.

**Progress is counted in items, never in person-days.** The quotation's unit was retired when the
work became AI-coded (`DIRECTIVE_2026-08-30_DELIVERY.md` §1.3).

**Silence is a defect.** If an instruction cannot be executed — tooling, permissions, dependencies,
environment, scope conflict — say so within 24 hours with the blocker, its evidence, and at least
one alternative. Do not go quiet. `stall-check.yml` will open an issue if you do.

**One reviewable change per pull request**, with green CI. Commits of 100+ files cannot be reviewed
and have hidden real defects in this repository before.

**Never present fixture data as live.** A Class B surface backed by mock or static data while shown
as functional fails the audit (`ACCEPTANCE.md` §7.5).

**Do not rebuild Class A.** `PRD.md` §2.1 surfaces are preserved, not rebuilt; rebuilding them is
out of scope and not billable.

## 3. Hard boundaries

- No private keys, seed phrases, credentials, database dumps, or raw signed transactions — not in
  Web, API, MySQL, servers, GitHub, CI, or logs. Signing stays local and offline.
- All RPC, deployment, broadcast, receipt, explorer and external-marketplace calls originate from
  the approved SIN execution zone.
- **ArtFi is a trading intermediary, not an exchange** (`PRD.md` §4.2). ArtFi never takes possession
  of, and never holds authority to move, a user's funds or assets. Every change to a user's holdings
  originates from a signature that user produced for that specific trade. Orders are signed intents;
  matching is discovery, not execution; the chain is the ownership authority, never MySQL or Redis.
  No administrative action may move, freeze, or reassign user assets.
- **Two business roles, one set of rules** (`PRD.md` §4.2.1). ArtCCH sells its own inventory
  (自营) and third parties' (中介). Treat ArtCCH's assets as customer assets whose account happens
  to belong to ArtCCH. Never build a seller allowlist, a privileged listing path, or an
  administrative call that reaches ArtCCH's holdings. **Matching takes no input from seller
  identity** — ArtCCH's own orders get no ordering, latency, visibility or fee advantage. The
  distinction is disclosed to users, never branched on in settlement.
- No mainnet, real assets, or real-money operation without separate written approval.
- The test chain is **Hoodi `560048`**. It says nothing about the production chain, which is an
  open decision. `verify-chain-consistency.mjs` enforces that every layer agrees.
- Historical mint evidence is immutable: `release/mint-batches/ye-yongrun-unit-a01-a38` records a
  real Ethereum Sepolia mint (tx `0xfe71d3af…0534b`, block `11545902`). Never rewrite it, and never
  regenerate into that directory. Its verifiers stay pinned to `11155111` by design.
- Hoodi testing uses separately generated AI artwork (`PRD.md` §7.0), in its own namespace, on its
  own deployment, carrying `TESTNET` / `NO REAL-WORLD VALUE` / `NO LEGAL EFFECT`. It may never
  borrow a real artist's identity or reach a production manifest.
- Inherited screenshots and PRD claims are references, not proof of implementation.
- Keep external-wallet integration separate from the wallet extension.

## 4. Before handoff

Run the checks in `CONTRIBUTING.md` for the area you changed, then confirm:

- `pnpm chain:consistency:check` passes;
- `docs/STATUS.md` reflects this commit, with no `<SHA>` or `<YYYY-MM-DD>` placeholders left;
- every item you moved cites its evidence.
