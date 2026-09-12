# ArtFi agent instructions

Read this before touching the repository. This file defines the execution boundary for every coding, review, PM, audit, or AI agent working on ArtFi.

## 0. P0 governance rule

**Issue #84 — `[GOVERNING][NO COMMENTS] Stage 2 PRD v2.0 — NO-HIL Agentic RWA Market` — is the sole product baseline.**

No agent may create, infer, extend, reinterpret, or write back a product requirement that cannot be traced to #84 or to an explicit later client ruling.

This applies equally to Codex, Claude Code, reviewers, automation, and human contributors acting through an agent.

An agent may:

- implement an existing requirement;
- verify implementation against an existing requirement;
- report a gap, defect, conflict, risk, or missing decision;
- propose an option in a separate non-governing issue for client decision.

An agent may **not**:

- add a gate, status value, delivery condition, acceptance obligation, architecture requirement, product principle, scope item, dependency, or client obligation on its own authority;
- convert an observation, recommendation, risk, or interpretation into a requirement;
- amend #84 through comments, another document, a commit message, `ACCEPTANCE.md`, `STATUS.md`, or an issue;
- make its own proposed rule authoritative by writing it into a governance or acceptance document;
- block implementation on a condition that is not traceable to #84 or an explicit client ruling.

**If no trace exists, it is not a requirement. Report it; do not legislate it.**

---

## 1. Authority order

Use the following authority order. Lower levels may explain or record higher levels; they may never expand them.

| Priority | Source                                                                   | Role                                                                                                         |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1        | **Issue #84**                                                            | Sole product baseline: what ArtFi is and what must be built                                                  |
| 2        | **Explicit later client rulings**                                        | Authorized amendments or decisions; must identify the client ruling and must not be invented by an agent     |
| 3        | `AGENTS.md`                                                              | Execution and agent-control rules                                                                            |
| 4        | `docs/ACCEPTANCE.md`                                                     | Evidence and promotion process only                                                                          |
| 5        | `docs/STATUS.md`                                                         | Evidence snapshot only; it records state and creates no requirement                                          |
| 6        | legacy PRDs, roadmaps, directives, issues, comments, and commit messages | Historical/reference material only unless #84 or an explicit client ruling incorporates a specific provision |

**No issue number other than #84 is automatically governing merely because an older document or comment calls it governing.** Temporary cleanup issues, audit issues, and historical PM issues are execution records only.

`docs/PRD.md` is **not an independent authority**. #84 preserves the required Stage 1 substrate; legacy Stage 1 detail may be used only to the extent that it is incorporated by #84 and does not conflict with #84 or a later client ruling.

If two sources conflict, use the higher source. Do not reconcile a conflict by inventing a third rule.

---

## 2. Mandatory traceability

Every change that claims to satisfy product scope must cite one of:

1. a specific section of #84; or
2. an explicit later client ruling.

Every audit finding must separately identify:

- **baseline:** the #84 section or client ruling;
- **evidence:** file path, test, CI run, transaction/receipt, or observed runtime behaviour;
- **finding:** what does not match.

If the baseline field cannot be filled, the finding may be recorded as a recommendation or question, but **must not become a blocker or requirement**.

---

## 3. Governance contamination rule

The repository contains historical AI-authored requirements that exceeded the agent's authority. Issues #91 and #92 identify known examples.

During cleanup:

- remove or freeze requirements, gates, states, delivery obligations, and derived blockers that have no valid trace to #84 or an explicit client ruling;
- preserve valid client rulings even where an agent previously over-expanded them;
- preserve useful implemented code, tests, security fixes, and infrastructure when they remain compatible with #84;
- do not roll back working implementation merely because Claude Code or another AI contributed it;
- do not keep an invalid requirement merely because implementation effort has already been spent on it;
- do not create replacement requirements while deleting invalid ones.

**Governance rollback is not code rollback. Provenance alone is never a reason to delete useful code.**

Where useful existing code is not currently required for the active delivery stage but is compatible with #84, freeze it in place rather than expanding current scope around it. Delete code only when it is demonstrably harmful, contradictory, dead, security-sensitive, or creates an active maintenance/behavioural conflict.

---

## 4. Staged delivery — anti-black-hole rule

ArtFi is delivered in bounded stages. The project must not remain in an indefinitely expanding pre-delivery state.

For each active stage:

1. define a finite deliverable set traced to #84;
2. freeze that stage's scope before implementation begins;
3. finish, test, integrate, and demonstrate that set;
4. record remaining valid requirements as later-stage work;
5. do not pull later-stage work forward unless it is a true technical prerequisite for the active stage;
6. do not add new requirements during implementation without an explicit client ruling.

A later-stage missing feature is **not** a blocker for the current stage unless the current stage cannot function without it.

The default priority is:

```text
finish useful existing work
→ close the current bounded stage
→ demonstrate it
→ only then open the next stage
```

Not:

```text
find more requirements
→ enlarge the gate
→ redesign the stage
→ defer delivery
→ repeat
```

No audit, review, refactor, architecture exercise, or governance activity may indefinitely displace delivery of a bounded working slice.

---

## 5. Standing engineering rules

**Evidence.** Self-assessment is not delivery evidence. Every delivery claim cites a file path, test name, CI run, or transaction hash with receipt as applicable.

**Status.** `docs/STATUS.md` records evidence and current state. It does not create scope. Status vocabulary must not be expanded by an agent.

**One reviewable change per pull request.** Prefer bounded, reviewable PRs with green CI. Avoid broad speculative rewrites.

**Fixtures are not live product data.** Never present mock/static data as live behaviour.

**Do not rebuild valid working surfaces without a product reason.** Preserve useful existing implementation and improve only where #84 or a verified defect requires it.

**Blockers must be real.** A blocker must identify the exact active-stage requirement it prevents and the evidence for the dependency. Unsupported or later-stage work is not a blocker.

**Questions do not block by default.** If #84 leaves something unspecified, choose the least-expansive reversible implementation that preserves #84, or raise a separate question. Do not freeze delivery by inventing an approval dependency.

---

## 6. Hard boundaries

- No private keys, seed phrases, credentials, database dumps, or raw signed transactions in Web, API, MySQL, servers, GitHub, CI, or logs.
- No mainnet, real assets, or real-money operation without separate written approval.
- The current test chain is Hoodi `560048`; it does not determine the production chain.
- Historical mint evidence must remain immutable.
- Test assets must remain clearly isolated from production/real-asset records.
- External partner identities in governing product material must use the neutral placeholder policy already stated in #84.
- LLM output is advisory; transaction authority must come from deterministic policy and valid authority as defined by #84.
- An operational agent must never infer higher authority from lower authority.

---

## 7. Cleanup protocol

When performing a repository-wide cleanup, classify every disputed item into exactly one of four buckets:

### KEEP

Implemented and useful, compatible with #84. Preserve it and its valid tests/evidence.

### FINISH-NOW

Valid #84 requirement needed for the currently declared delivery stage and sufficiently close to completion. Finish it within the bounded stage.

### FREEZE-LATER

Valid under #84 but not required for the current stage. Keep existing useful work, stop expansion, and move it to a later-stage backlog.

### REMOVE

No valid trace to #84/client ruling, or actively harmful/contradictory/dead. Remove the invalid governance requirement or, where justified, the conflicting implementation.

Every REMOVE decision must state what valid source, if any, replaces it. `No replacement — agent-authored scope expansion` is acceptable.

Do not use cleanup to generate a fifth bucket of newly invented work.

---

## 8. Before handoff

Before declaring a stage or cleanup batch complete, confirm:

- all changed product behaviour traces to #84 or an explicit later client ruling;
- no new agent-authored requirement, gate, status, or delivery condition was introduced;
- useful compatible implementation was preserved;
- current-stage scope is finite and written down;
- later-stage items are frozen rather than allowed to block current delivery;
- tests and CI for the changed area are green;
- `docs/STATUS.md` records evidence only and does not expand scope;
- any unresolved question is clearly marked non-governing and non-blocking unless the client explicitly ruled otherwise.

**Primary operating principle: deliver bounded working stages; do not turn ArtFi into an endless governance project.**


## Stage-Based Delivery Rule

Agents must work on the current stage only.

Agents MUST NOT:

- move future-stage requirements into current acceptance;
- create additional gates;
- redefine protocol semantics;
- expand PRD scope.

Agents MUST:

- implement;
- test;
- provide evidence;
- freeze completed stages.

Preserve existing code.

Classification:

- KEEP
- FINISH-NOW
- FREEZE-LATER
- REMOVE

The client-approved [ArtFi + Oracle Delivery Stage Framework v1.1](https://github.com/GiraffeTechnology/ArtFi/issues/100) separates stage acceptance without lowering engineering standards or expanding product scope. Each stage has independent acceptance. Future-stage capabilities MUST NOT block current-stage delivery.
