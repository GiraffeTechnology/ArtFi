# ArtFi delivery reset

This document controls sequencing only. Product scope comes from issue #84 or an explicit later client ruling.

## Current bounded stage

Complete one TEST_ONLY bounded-agent lifecycle for an NFT BUY: observe a source-attributed state, validate a signed intent and deterministic policy bounds, durably reserve it, record STARTED before dispatch, verify or reconcile the result, and preserve safe query and revocation during source failure. This slice traces to issue #84 §§9–18 and §§32–34. It does not claim Stage 2 acceptance or authorize mainnet, real assets, custody, or stored user keys.

## KEEP

- Current `main` implementation and tests that remain compatible with issue #84, including auction, revenue, Safe, marketplace-read, deployment-guard, CI, and security work.
- The governance cleanup already merged through #91/#94/#95/#97.
- The bounded Agent modules and their deterministic tests under `scripts/agent/`.
- Useful draft implementation in PRs #66 and #67, without treating either draft as current-stage acceptance evidence.

## FINISH-NOW

- Integrate the bounded Agent modules on current `main` without importing stale branch evidence.
- Prove the local lifecycle, restart recovery, revocation, duplicate-execution refusal, source-outage behavior, and UI state with the repository tests for this exact commit.
- Run the applicable repository gates and obtain same-head CI and review for this bounded change.

## FREEZE-LATER

- Additional Agent action types, provider failover, production operations automation, live Oracle/RPC composition, and the complete A1–A10 acceptance matrix.
- PR #66 monitoring and PR #67 database-pool work until their own bounded stages and required runtime inputs are available.
- Live chain, production deployment, soak, and later Stage 2 evidence. These remain valid product work but do not block exit from this implementation slice.

## REMOVE

- Unsupported G0/`GRAY_AVAILABLE` governance obligations and derived blockers identified by #91/#92; the merged cleanup is preserved and not reimplemented here.
- Deleted or superseded AI-authored work-queue rules as active authority. No replacement: they were not product requirements.
- PR #80 as an active delivery path if it still makes CI intentionally non-green; preserve any useful policy test separately rather than making an impossible workflow a gate.

## Stage exit evidence

- `pnpm agent:test` passes on the exact candidate and covers authorized execution, persistent STARTED-before-dispatch, retry/reconcile without duplicate execution, exact confirmed revocation, source outage, reservation uniqueness, and durable recovery.
- Applicable format, secret, build, and repository tests pass; GitHub CI is green on the same head.
- The browser demonstration shows TEST_ONLY query, revoke, stale-source, terminal, and restart-recovery states without fixtures presented as live data.
- `docs/STATUS.md` records the exact evidence without promoting any of the existing 60 Stage 1 items.

## Next stage — frozen until current exit

Choose the next smallest issue-#84 slice from live adapter composition, additional Agent actions, or autonomous operations only after the current bounded stage has the evidence above. Later missing work remains recorded but is not a blocker for this stage.
