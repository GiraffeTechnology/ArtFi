# Stage 2 bounded delivery acceptance

Status: evidence and promotion process only. This document creates no product requirement.

## Authority and precedence

- Product baseline: issue #110 §0 Part A, which incorporates issue #84 unchanged for Stage 2.
- Delivery execution ruling: the client recovery plan dated 2026-09-08, SHA-256
  `D2E25148E4F25E5CC94BDB7C99D36F7D3A9BB3608B28962D1012A8591DD445F4`.
- Repository execution rules: `AGENTS.md`.
- Status vocabulary and evidence rules: `docs/ACCEPTANCE.md` §§2–3.

Issue #110 controls if an older delivery document differs. This file maps existing authority to a
finite first slice; it does not amend issue #110, add a gate, or redefine final delivery.

## Frozen first-slice scope

The first bounded candidate is `TEST_ONLY_NO_REAL_VALUE` and supports exactly one signed NFT
`BUY` path for one declared test asset. The path is:

```text
signed bounded intent
→ deterministic plan and policy
→ Oracle PreMint evidence check
→ execution adapter
→ receipt verification
→ reconciliation
→ autonomous recovery or SAFE_DEGRADED
```

The slice preserves these boundaries:

- no mainnet, real asset, real value, custody, or stored user key;
- no authority inferred from an LLM, browser, database row, or Oracle verdict;
- no direct Oracle SDK dependency in ArtFi runtime composition;
- no transaction execution owned by the Oracle integration;
- no Charity behavior or ERC implementation change;
- unsupported actions remain unimplemented rather than silently authorized.

Broader actions, providers, product lines, soak, hardening, and go-live work remain valid later-stage
work. Their absence does not expand this slice and must not be presented as completed.

## Capability matrix

The capability names and meanings come from issue #110 §0 Part A (issue #84 §§8–25). A row passes
only with evidence on one exact candidate commit and environment.

| Capability                    | First-slice proof                                                                                                            | Current evidence class                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A1 Observe                    | Timestamped source state distinguishes current, stale, unavailable, restricted, and unverified inputs                        | Agent contract tests; runtime proof still required                               |
| A2 Intent                     | Exact signed `BUY` boundaries, expiry, revocation, replay, consumption, malformed input, and unsupported action are enforced | Agent contract tests; runtime proof still required                               |
| A3 Reason                     | A bounded plan is produced without granting authority; deterministic operation remains possible without an LLM               | Injectable deterministic planner; runtime proof still required                   |
| A4 Policy                     | Intent, asset, source, financial, nonce, replay, exposure, and health checks fail closed                                     | Agent contract tests; runtime proof still required                               |
| A5 Execute                    | One authorized test action is dispatched once through the existing approved execution boundary                               | Interface and state machine exist; actual test-chain adapter evidence is missing |
| A6 Verify                     | Submission is not completion; receipt and binding are checked before settlement                                              | Interface and receipt verifier exist; actual receipt evidence is missing         |
| A7 Recover                    | Restart, timeout, dependency outage, ambiguous execution, and reconciliation reach `RECOVERED` or `SAFE_DEGRADED`            | Deterministic fake-backed tests; real dependency-failure evidence is missing     |
| A8 Learn                      | Any learning remains non-authoritative and cannot expand the signed envelope                                                 | No first-slice implementation claim                                              |
| A9 RWA Grounding              | Required PreMint evidence is valid, current, unrevoked, source-bound, and asset-bound                                        | Oracle API consumer tests; live Oracle evidence is missing                       |
| A10 Constitutional Governance | Operational code cannot alter signer roots, approved-source trust, roles, contracts, or global powers                        | Boundary is declared; integrated runtime evidence is missing                     |

## Stage 2 gates

The gate names come from issue #110 §0 Part A (issue #84 §38). These are evidence checkpoints, not
new requirements.

| Gate                   | Exit evidence for this slice                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A0 Architecture        | Exact scope, authority layers, signed-intent schema, Oracle API boundary, source model, and failure policy are frozen on the candidate commit    |
| A1 Agent Core          | Observe → plan → policy → execute → verify → reconcile completes for the declared test asset                                                     |
| A2 Bounded Authority   | Exact boundary succeeds and over-limit, expired, revoked, replayed, consumed, malformed, and unsupported inputs fail                             |
| A3 RWA Grounding       | Valid evidence permits the eligible path; missing, invalid, expired, revoked, mismatched, and unavailable evidence fail closed                   |
| A4 Autonomous Recovery | Injected DB, RPC, provider, Oracle/source, restart, crash, and timeout cases autonomously recover or safely degrade                              |
| A5 Gray Operation      | The exact candidate runs continuously with monitoring and no manual runtime repair in the measured window                                        |
| A6 NO-HIL Soak         | The declared soak includes normal actions, refusals, retries, recovery, source failure, and reconciliation with zero routine human interventions |

Passing a unit or fixture test does not clear a runtime gate. A later-stage missing feature does not
fail the bounded slice unless it is a technical prerequisite of the declared path.

## Executive delivery gates

The client recovery plan defines the first-candidate summary:

| Gate                    | Required observed outcome                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| D1 Authority            | The Agent cannot exceed the active signed intent                                                |
| D2 Asset Truth          | An unverified RWA cannot mint or activate                                                       |
| D3 Autonomous Execution | Intent → execute → verify → reconcile completes without operational human approval              |
| D4 Autonomous Recovery  | A recoverable failure reaches `RECOVERED` or `SAFE_DEGRADED` without routine human intervention |

`DELIVERY_CANDIDATE` is reserved until D1–D4 and one complete vertical slice pass on the same exact
candidate, together with the minimum UI below. This narrower candidate does not claim final
delivery, production readiness, go-live authorization, or completion of every Stage 1/2 item.

## Minimum UI evidence

The same running candidate must expose:

- create intent;
- view intent;
- revoke intent;
- view asset grounding;
- view execution state;
- view settlement and reconciliation state;
- view system and recovery state.

Browser fixtures may prove rendering and negative states, but cannot be reported as live runtime
evidence. The UI must identify `TEST_ONLY_NO_REAL_VALUE` and must never expose credentials,
private keys, signatures, raw signed transactions, or internal topology.

## Evidence record

For every promotion claim, record:

- exact commit and tree;
- environment and test-chain identity;
- command or browser flow;
- CI run and jobs with actual executed steps;
- transaction hash and receipt when an action reaches the chain;
- durable database/restart evidence when persistence or recovery is claimed;
- failure injection and autonomous terminal state;
- fixture, simulated, and live evidence classifications.

`docs/STAGE2_STATUS.md` records the current snapshot. It may only use the six statuses from
`docs/ACCEPTANCE.md` §2 and cannot create or waive a requirement.
