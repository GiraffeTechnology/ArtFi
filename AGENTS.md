# ArtFi agent instructions

Read this before touching the repository. This file defines the execution boundary for every coding, review, PM, audit, or AI agent working on ArtFi.

## 0. P0 governance rule

**Issue #110 — `[GOVERNING][NO COMMENTS] ArtFi Product Baseline — #84 plus the 2026-09-18 rulings` — is the sole product baseline.**

#110 **incorporates #84 by reference and does not replace it.** #84 remains the text for Stage 1 / Stage 2 architecture, A1–A10, the A0–A6 gates, the authority model, key safety and partner neutrality. #110 adds what #84 does not cover — product positioning, the charity NFT module, external-marketplace mirroring, and the delivery standard — and where the two differ, #110 controls. **Cite #110, not #84.** #84 stays locked and unedited as the historical record.

No agent may create, infer, extend, reinterpret, or write back a product requirement that cannot be traced to #110 or to an explicit later client ruling.

This applies equally to Codex, Claude Code, reviewers, automation, and human contributors acting through an agent.

An agent may:

- implement an existing requirement;
- verify implementation against an existing requirement;
- report a gap, defect, conflict, risk, or missing decision;
- propose an option in a separate non-governing issue for client decision.

An agent may **not**:

- add a gate, status value, delivery condition, acceptance obligation, architecture requirement, product principle, scope item, dependency, or client obligation on its own authority;
- convert an observation, recommendation, risk, or interpretation into a requirement;
- amend #110 through comments, another document, a commit message, `ACCEPTANCE.md`, `STATUS.md`, or an issue;
- make its own proposed rule authoritative by writing it into a governance or acceptance document;
- block implementation on a condition that is not traceable to #110 or an explicit client ruling.

**If no trace exists, it is not a requirement. Report it; do not legislate it.**

---

## 1. Authority order

Use the following authority order. Lower levels may explain or record higher levels; they may never expand them.

| Priority | Source                                                                   | Role                                                                                                          |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1        | **Issue #110** (incorporates #84)                                        | Sole product baseline: what ArtFi is and what must be built                                                   |
| 2        | **Explicit later client rulings**                                        | Authorized amendments or decisions; must identify the client ruling and must not be invented by an agent      |
| 3        | `AGENTS.md`                                                              | Execution and agent-control rules                                                                             |
| 4        | `docs/ACCEPTANCE.md`                                                     | Evidence and promotion process only                                                                           |
| 5        | `docs/STATUS.md`                                                         | Evidence snapshot only; it records state and creates no requirement                                           |
| 6        | legacy PRDs, roadmaps, directives, issues, comments, and commit messages | Historical/reference material only unless #110 or an explicit client ruling incorporates a specific provision |

**No issue number other than #110, and #84 through it, is automatically governing merely because an older document or comment calls it governing.** Temporary cleanup issues, audit issues, and historical PM issues are execution records only.

`docs/PRD.md` is **not an independent authority**. #110 preserves the required Stage 1 substrate; legacy Stage 1 detail may be used only to the extent that it is incorporated by #110 and does not conflict with #110 or a later client ruling.

If two sources conflict, use the higher source. Do not reconcile a conflict by inventing a third rule.

### 1.1 Product invariants

Client rulings of 2026-09-18 and 2026-09-19. Invariants 1–5 are recorded in
[`docs/DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md`](docs/DIRECTIVE_2026-09-18_PRODUCT_ALIGNMENT.md);
invariants 6 to 9 are the 2026-09-19 rulings, recorded in `docs/PRD.md` §1, §3.2 and in
[`docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md).
Priority 2 in the table above. These rules preserve the commercial product design; they are cited,
not invented, and they create no new delivery obligation.

1. **ArtFi is a commercial platform.** It must not be treated as an ERC-8415 demo application.
2. **Supported product models** are artwork receipt assets, artwork investment funds, and charity NFT editions.
3. **ERC-8415 boundary.** ERC-8415 applies to asset identity, registry synchronization, ownership-related workflows, and asset lifecycle management.
4. **Charity NFT boundary.** Charity NFT is an independent product line and must not be forced into the ERC-8415 asset model.
5. **Governance boundary.** DAO governance follows the underlying product structure. Economic participation and governance authority must be explicitly defined by the corresponding asset model. Token possession alone does not define governance rights.
6. **Venue and rollout boundary.** Client ruling of 2026-09-19, recorded in [`docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md). **All trading is available both on ArtFi and on OpenSea, and ArtFi is primary.** **Third-party venues are an early-stage state**; the target is ArtFi itself as an ERC-8415-standard artwork RWA market. That is product direction, not scope: **whether, when or how third-party venue support is reduced is a client decision**, the external-market mirror stays built, tested and counted until one is made, and no gate, status value or delivery condition follows from the direction.
   - **On ArtFi**, trading settles by signature. **Never custody, never counterparty, never a user's asset moved without that user's signature for that fill.** Being a venue is not permission to hold.
   - **On OpenSea**, ArtFi mirrors attributed data and links out; execution there completes on OpenSea. The mirror never creates, signs, matches, custodies, fulfils or settles on the venue's behalf.
   - **Rollout is staged per product line** — whole artwork behind an Oracle path, an ERC-8415 wallet and ArtCCH registration projected to `<REGISTRY_CHAIN_A>`; fractions behind exempt-market compliance; charity on OpenSea first, then ArtFi, with **delivery launch-ready at any point**.
   - **The rollout sequence is not a gate.** It adds nothing to G1–G4, creates no status value, and blocks no requirement. **A track that has not opened is still built, tested and counted.** An agent that turns this into a gate repeats the `G0` mistake #91 and #94 removed.
   - An earlier ruling the same day made OpenSea the sole whole-artwork venue with ArtFi as mirror only. It is superseded; the conflict is recorded in `docs/PRD.md` §1.

7. **Vendor neutrality in operations.** Delivery and the database run on `<CLOUD_PROVIDER_A>`; on-chain operation runs in the **SIN execution zone** on `<CLOUD_PROVIDER_B>`; an operations agent maintains 24/7 service and reaches a model through `<LLM_PROVIDER_A>`. **`<LLM_PROVIDER_A>` is swappable at any time** — ArtFi is not in that vendor's ecosystem. No prompt, schema or control path may depend on one model vendor, and model output stays advisory (§6). Real vendor names never enter governing product material (#110 §4).

8. **Holder authority.** Client ruling of 2026-09-19, recorded in `docs/PRD.md` §1.0.5. **Registries of record are a class, not a company**: ArtCCH's registry is part of its own-account business and has **the same nature as a third-party registry chain** (`<REGISTRY_CHAIN_A>`). For a registry-backed asset the **registry of record is the holder authority**, and the on-chain token is its projection. It records the artwork's physical parameters, the holder, and provenance.
   - **The authority belongs to the registrar role, not to ArtCCH as an operator.** Structurally ArtFi treats ArtCCH as a third party; any other registrar in the same role is handled by the same paths. **ArtFi is a consumer of registries and operates none of them.**
   - This does **not** reopen §1.4.1 of the 2026-08-30 ruling. No seller allowlist, no role restricting who may list, no administrative interface able to move ArtCCH's holdings, matching blind to seller identity, and the self-operated / intermediary distinction never branches the settlement path. **Being the registrar of record for an asset is not a trading privilege over it.**
   - **ArtFi's own stores remain authoritative for nothing.** "Redis and MySQL are not the ownership authority" stands; a registry of record is not an ArtFi database.
   - Three records — registry of record (authority), chain (projection and settlement), ArtFi's projection (read-only, no rights claim). **ArtFi never resolves a divergence by asserting its own projection; it reports.** Which way a registry-versus-chain divergence resolves is a client decision and must not be invented by an agent.

9. **Delivery standard.** Client ruling of 2026-09-19, recorded in `docs/PRD.md` §3.2 and [`docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md`](docs/DIRECTIVE_2026-09-19_TRADING_AND_ROLLOUT.md) §3. **ArtFi is delivered in stages, not as one complete end-state handover** — only the complete RWA market is handed over whole. **Every delivery is measured by what is visible and operable in the UI**: a stage is delivered when a user in its intended role can carry out its function from the ArtFi UI, desktop and mobile, with G1 sign-off and evidence per `docs/ACCEPTANCE.md` §3 and §6.2. **The screen is the deliverable** — an endpoint, contract, test or generated client that no screen reaches is progress, not a handover.
   - This is a delivery standard, **not new scope**. It adds no gate (G1–G4 unchanged), no status value (the six values stand), no requirement and no `STATUS.md` row; the stage table in `docs/PRD.md` §3.2.3 groups requirements that already exist in §4.
   - **A stage does not require mainnet.** `ACCEPTANCE.md` §6 items 7–10 remain the terminus for the complete market only.
   - **Visual design is the client's track.** Same ruling: the UI is being redone in Figma and the delivered version is verified on **functional** delivery. "UI-visible" means the function is operable from a screen, not that the screen is final. A pending redesign neither blocks nor invalidates a stage; prefer shared classes and semantic markup so a re-skin costs stylesheet work, not rebuilt components. **Nothing functional relaxes** — fail-closed behaviour, absent previews, rights disclosures and verification gates are function, not styling. Whether the Figma work replaces G1's `pics/*.png` baseline is a client decision and must not be assumed by an agent.
   - **The production version is assembled once, at the end.** Client ruling of 2026-09-19, recorded in `docs/PRD.md` §3.2.5. A stage delivers against the test chain and carries no production build, deployment, production-grade design or go-live packaging; `ACCEPTANCE.md` §6 items 7–10 stay with the complete market. **No stage may be blocked on production readiness, and no agent may pull production work forward to prepare for it.** Building is not assembling: an unopened or not-yet-productionised track is still built, tested and counted.
   - **Stage order is not build order.** Opening follows the rollout sequence in invariant 6; engineering does not wait on it, and an unopened track is still built, tested, counted and kept launch-ready.

---

## 2. Mandatory traceability

Every change that claims to satisfy product scope must cite one of:

1. a specific section of #110; or
2. an explicit later client ruling.

Every audit finding must separately identify:

- **baseline:** the #110 section or client ruling;
- **evidence:** file path, test, CI run, transaction/receipt, or observed runtime behaviour;
- **finding:** what does not match.

If the baseline field cannot be filled, the finding may be recorded as a recommendation or question, but **must not become a blocker or requirement**.

---

## 3. Governance contamination rule

The repository contains historical AI-authored requirements that exceeded the agent's authority. Issues #91 and #92 identify known examples.

During cleanup:

- remove or freeze requirements, gates, states, delivery obligations, and derived blockers that have no valid trace to #110 or an explicit client ruling;
- preserve valid client rulings even where an agent previously over-expanded them;
- preserve useful implemented code, tests, security fixes, and infrastructure when they remain compatible with #110;
- do not roll back working implementation merely because Claude Code or another AI contributed it;
- do not keep an invalid requirement merely because implementation effort has already been spent on it;
- do not create replacement requirements while deleting invalid ones.

**Governance rollback is not code rollback. Provenance alone is never a reason to delete useful code.**

Where useful existing code is not currently required for the active delivery stage but is compatible with #110, freeze it in place rather than expanding current scope around it. Delete code only when it is demonstrably harmful, contradictory, dead, security-sensitive, or creates an active maintenance/behavioural conflict.

---

## 4. Staged delivery — anti-black-hole rule

ArtFi is delivered in bounded stages. The project must not remain in an indefinitely expanding pre-delivery state.

For each active stage:

1. define a finite deliverable set traced to #110;
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

**Do not rebuild valid working surfaces without a product reason.** Preserve useful existing implementation and improve only where #110 or a verified defect requires it.

**Blockers must be real.** A blocker must identify the exact active-stage requirement it prevents and the evidence for the dependency. Unsupported or later-stage work is not a blocker.

**Questions do not block by default.** If #110 leaves something unspecified, choose the least-expansive reversible implementation that preserves #110, or raise a separate question. Do not freeze delivery by inventing an approval dependency.

---

## 6. Hard boundaries

- No private keys, seed phrases, credentials, database dumps, or raw signed transactions in Web, API, MySQL, servers, GitHub, CI, or logs.
- No mainnet, real assets, or real-money operation without separate written approval.
- The current test chain is Hoodi `560048`; it does not determine the production chain.
- Historical mint evidence must remain immutable.
- Test assets must remain clearly isolated from production/real-asset records.
- External partner identities in governing product material must use the neutral placeholder policy already stated in #110.
- LLM output is advisory; transaction authority must come from deterministic policy and valid authority as defined by #110.
- An operational agent must never infer higher authority from lower authority.

---

## 7. Cleanup protocol

When performing a repository-wide cleanup, classify every disputed item into exactly one of four buckets:

### KEEP

Implemented and useful, compatible with #110. Preserve it and its valid tests/evidence.

### FINISH-NOW

Valid #110 requirement needed for the currently declared delivery stage and sufficiently close to completion. Finish it within the bounded stage.

### FREEZE-LATER

Valid under #110 but not required for the current stage. Keep existing useful work, stop expansion, and move it to a later-stage backlog.

### REMOVE

No valid trace to #110/client ruling, or actively harmful/contradictory/dead. Remove the invalid governance requirement or, where justified, the conflicting implementation.

Every REMOVE decision must state what valid source, if any, replaces it. `No replacement — agent-authored scope expansion` is acceptable.

Do not use cleanup to generate a fifth bucket of newly invented work.

---

## 8. Before handoff

Before declaring a stage or cleanup batch complete, confirm:

- all changed product behaviour traces to #110 or an explicit later client ruling;
- no new agent-authored requirement, gate, status, or delivery condition was introduced;
- useful compatible implementation was preserved;
- current-stage scope is finite and written down;
- later-stage items are frozen rather than allowed to block current delivery;
- tests and CI for the changed area are green;
- `docs/STATUS.md` records evidence only and does not expand scope;
- any unresolved question is clearly marked non-governing and non-blocking unless the client explicitly ruled otherwise.

**Primary operating principle: deliver bounded working stages; do not turn ArtFi into an endless governance project.**
