# Deleted branch ledger — 2026-09-29

**Record only.** This file creates no requirement, gate, status value or delivery condition. It exists
so that pruning a branch loses nothing: every ref removed below is written down with the exact commit
it pointed at, and any of them is restored with

```sh
git push origin <sha>:refs/heads/<branch>
```

## Why these and not others

The repository held 55 remote branches, the oldest from 2026-08-19. The rule applied was mechanical,
so that nothing was removed on taste:

- **Kept** — `main`, the active branch, and every branch that is the head **or the base** of an open
  pull request. That covers Codex's in-flight agent stack (#113, #116–#122), the five Dependabot
  branches, and the older drafts #66, #67, #80, #101 and #102. Deleting the base of a stacked pull
  request closes it, so bases were kept even where nothing points at them directly.
  `codex/agent-revocation-hash-boundary-20260920` carries no pull request of its own but sits on top
  of that same stack, so it was kept with it.
- **Removed** — every branch with no open pull request. Four of them
  (`agent/prechain-ui-public`, `agent/cchsc-language-parity`,
  `agent/remove-redundant-mirror-badge`, `agent/ui-brand-readonly-mirror`) hold nothing `main` does
  not already have in its history, and show 0 in the last two columns below. The other 28 carry
  commits `main` lacks, which is why each one's tip is recorded here rather than assumed disposable.

Two branches whose commits are entirely inside `main`'s history —
`codex/s-xm-backfill-resilience-r2-20260919` and `codex/vendor-neutral-operations-20260919` — were
**not** removed, because they are the base and head of open pull request #115. Their content was
reverted from `main` on 2026-09-25 and re-applied on `claude/ci-all-pr-6dytk9`, so it returns to
`main` with that branch rather than with theirs.

## Removed refs

| Branch                                                        | Tip                                        | Last commit                                                                           | Commits ahead of `main` | Files differing from `main` |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------- | --------------------------- |
| `agent/base-sepolia-batch-release`                            | `f4a5b02e09218b46d4cec0e0df7b7555ac3b15fb` | 2026-08-23 — feat(testnet): add Base Sepolia batch and A02 DAO validation             | 1                       | 60                          |
| `agent/cchsc-language-parity`                                 | `915577fca4ce83027d55356ae0ef92c5afa7dddb` | 2026-08-22 — feat(ui): align language entry with CCHSC                                | 0                       | 0                           |
| `agent/prechain-ui-public`                                    | `18bb0b23ecfa6c54d6db486670e6e9ad6538df6d` | 2026-08-21 — feat: complete prechain UI and SIN-gated delivery                        | 0                       | 0                           |
| `agent/remove-redundant-mirror-badge`                         | `50c81bbac3d15b3af6ecf26c72c9ab89d891f26b` | 2026-08-22 — fix(ui): remove redundant OpenSea mirror badge                           | 0                       | 0                           |
| `agent/stage-0-foundation`                                    | `7aac472a27335bfcb7bf60180edac4720ef78c21` | 2026-08-19 — Establish Stage 0 foundation                                             | 1                       | 35                          |
| `agent/stage-1-readonly-dapp`                                 | `d4e0e9628938233ddf54d30bf885c4698cf405ef` | 2026-08-20 — Merge pull request #11 from GiraffeTechnology/agent/stages-2-7-completio | 15                      | 181                         |
| `agent/stages-2-7-completion`                                 | `be8b82780f0c35b4d219ce2d38ed17e63f9ddbe1` | 2026-08-20 — complete charity editions and approved ArtCCH UI                         | 14                      | 181                         |
| `agent/ui-brand-language`                                     | `43323718dcd8bb370870e498d1d9fd3bf283a9e8` | 2026-08-20 — feat(web): add compliant brand lockup and AIVAN i18n                     | 16                      | 187                         |
| `agent/ui-brand-readonly-mirror`                              | `b80bd179ae9ce4ad3ceac3790c35b6504daa5ee9` | 2026-08-22 — fix(web): preserve mint navigation in header                             | 0                       | 0                           |
| `agent/wallet-local-test-signer`                              | `16c5a4e920349fc67bca779f1858ccd4adb20e56` | 2026-08-21 — feat(wallet): add local read-only test signer                            | 1                       | 9                           |
| `claude/55a-admin-safe-contract`                              | `4fa012431aeb9a8bd9d2f864527b6f1743841b3e` | 2026-09-05 — Add the threshold admin safe and its deployment policy, without the role | 1                       | 15                          |
| `claude/55b-1-safe-proposal-path`                             | `c8684d874f94c1011ac926ee2e1190185367d968` | 2026-09-07 — docs(status): restore change log table structure                         | 6                       | 4                           |
| `claude/charity-holder-runtime`                               | `d8672ba8e9d043e74e27c02e25e96f09cdb44b2f` | 2026-09-19 — feat(charity): gate the holder benefit behind verified wallet ownership  | 1                       | 13                          |
| `claude/erc-standard-feasibility-audit-90ypms`                | `8abb43d410e6d465b1c6cb83c74a3e9ff847e50c` | 2026-09-05 — docs: charity editions are not one profile of one system, they are a sep | 3                       | 2                           |
| `claude/g0-gray-deployment`                                   | `2e17fa25157c3433c3bf3f11999ac932544037f6` | 2026-09-07 — Merge remote-tracking branch 'origin/main' into claude/g0-gray-deploymen | 3                       | 2                           |
| `claude/land-65-market-503`                                   | `cad8523ef26bdc8f79355dd865dfb888a65d709f` | 2026-09-05 — Merge remote-tracking branch 'origin/codex/market-persistence-503-63fcf8 | 3                       | 7                           |
| `claude/land-m1-5-revenue`                                    | `808e15eb926a8b13634d0dfbee2f8273576ab389` | 2026-08-31 — Land claim-based revenue distribution on main (M1.5)                     | 1                       | 5                           |
| `claude/m19-asset-correspondence`                             | `4013849964bad43f21b3a03c9f00ecd1b78e65ed` | 2026-09-07 — Merge remote-tracking branch 'origin/main' into claude/m19-asset-corresp | 2                       | 2                           |
| `claude/open-items-9-12`                                      | `dacbd379c4365ddde959e11c21a7e76521c94ade` | 2026-09-05 — Record the deployment topology ruling: CTYun off-chain, SIN on-chain     | 2                       | 1                           |
| `claude/p0-unlock-market-deploy`                              | `42d20c6c3fe1da5b82e2f1db55616a3d336fb4a4` | 2026-09-05 — Reject invalid addresses in preflight and probe the fraction-token depen | 2                       | 8                           |
| `claude/pause-never-freezes-holdings`                         | `cd10e27084b060b9fdf57e744e8846f9cd4468f9` | 2026-09-07 — A pause may stop new issuance and must never freeze holdings             | 1                       | 10                          |
| `claude/stamp-78fa689`                                        | `1cd34f58e09629a16e8eaedd977398869e46e2aa` | 2026-08-31 — docs: stamp 78fa689 and record the M1 auction and revenue work           | 1                       | 1                           |
| `claude/stamp-fdb90ff`                                        | `ca8e79fe9f71b820de370140e00c895ac9908758` | 2026-09-05 — Stamp fdb90ff and correct two references to a pull request that never ex | 1                       | 1                           |
| `cleanup/fix-main-format-blocker`                             | `602909083899ca1e66d01d74eb7f685624951c7c` | 2026-09-12 — Format AGENTS.md and README.md so the quality workflow can pass          | 1                       | 2                           |
| `cleanup/remove-agent-authored-gates`                         | `f19a5f6791d7b125dc9228bcb9e2c2a2948e7301` | 2026-09-12 — Merge remote-tracking branch 'origin/main' into cleanup/remove-agent-aut | 2                       | 2                           |
| `cleanup/remove-agent-authored-stall-rule`                    | `9c58811797789b71d5e9689a738eba5ab88f0b75` | 2026-09-12 — Merge remote-tracking branch 'origin/main' into cleanup/remove-agent-aut | 3                       | 3                           |
| `codex/m1-admin-safe-main-20260901T023000Z`                   | `3e94f1c6fafc8537435dc4f1521a0d3bfa1dbcee` | 2026-09-05 — style(status): apply repository formatting                               | 7                       | 22                          |
| `codex/m1-auction-post-pr46-20260831T010902Z`                 | `eab1a6c769a364f533ac1c4d1efec09ead290047` | 2026-09-01 — Implement claim-based revenue distribution (#49)                         | 6                       | 7                           |
| `codex/m1-revenue-distribution-stacked-pr48-20260831T043500Z` | `e5d12d12273280e6c3714e211597d04ffc981c1d` | 2026-09-01 — Make invariant handler reverts fail campaigns                            | 8                       | 7                           |
| `codex/market-persistence-503-63fcf8c4`                       | `74d7df142bcf125bc85bf22bc66789a71360a307` | 2026-09-12 — Merge remote-tracking branch 'origin/main' into codex-65-placeholders    | 11                      | 7                           |
| `codex/s-xm-backfill-resilience-20260919`                     | `05fc32e4be2a86fe02b9da129497b6f12233527f` | 2026-09-19 — fix(mirror): make REST gap fill fail closed                              | 1                       | 3                           |
| `codex/stage2-agent-reset-20260912`                           | `60e6b7252f09aebf2d6447d1c1f7c5f292cfcb09` | 2026-09-13 — fix(agent): make revocation recording recoverable                        | 8                       | 26                          |
