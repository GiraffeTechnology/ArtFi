# ArtFi Agent Instructions

Read this file before changing ArtFi. These rules apply to implementation, review, audit,
automation, and project coordination. Complete the client's bounded working product; do not
replace delivery with expanding requirements or repeated governance work.

## 0. Product authority

[Issue #110](https://github.com/GiraffeTechnology/ArtFi/issues/110) is the inherited product
baseline and incorporates [Issue #84](https://github.com/GiraffeTechnology/ArtFi/issues/84).
Explicit later client instructions amend the affected provisions and control a conflict.
Unchanged incorporated requirements remain binding.

The 2026-10-02 client clarification and delivery task define the three sections in this order:

1. Digital NFTs without physical-asset backing, linked to CCHS at `https://cchsc.ca`, with
   OpenSea as the primary, nonexclusive marketplace.
2. Whole-artwork RWA tokens as delivery vouchers or warehouse receipts, implemented as an
   ERC-8415 standard commercial product.
3. Fractional trading and DAO inherited from the original PRD and MVP.

The requested web delivery destination is `https://io.artcch.com`. This instruction does not
itself select the production chain or authorize real-asset or real-money execution.

Use the source hierarchy by purpose:

| Source                                                            | Authority and use                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| #110 with incorporated #84 and explicit later client instructions | Product requirements; the latest explicit client instruction controls the affected conflict                 |
| `docs/PRD.md`                                                     | Coordinated record of those requirements, not an independent source of new scope                            |
| `AGENTS.md`                                                       | Agent execution rules within the product authority                                                          |
| `docs/ACCEPTANCE.md`                                              | Applicable evidence and promotion process only                                                              |
| `docs/STATUS.md`                                                  | Current evidence and state only                                                                             |
| Other directives, issues, comments, and commit messages           | Historical or implementation references, except provisions explicitly incorporated by the product authority |

Do not modify or append interpretations to the locked governing issues. Cite #110 and the
specific applicable later instruction. A document title or an agent's use of the words
"client ruling" is not, on its own, evidence of a new client decision.

An agent may implement, verify, report a gap or conflict, or propose a separate option. It may
not invent a requirement, gate, status, architecture obligation, client input, approval cycle,
or global prerequisite. Writing a proposal into a PRD or acceptance file does not authorize it.

## 1. Product boundaries to preserve

### 1.1 Three sections and venue scope

- Retain the NFT/CCHS and charity-edition functionality. Digital NFT ownership conveys none
  of the physical-asset or redemption rights prohibited by CH.8. A donation record does not
  turn the NFT into physical backing.
- OpenSea is primary for the NFT section, not exclusive. Do not apply the old blanket
  "ArtFi is primary for every line" wording to this section.
- Whole-artwork tokens have receipt/voucher semantics. Do not label their chain ownership
  as unrestricted physical title or collapse them into fractional fund tokens.
- Preserve inherited fractionalization, trading, portfolio, and DAO workflows. Their
  presence in the latest three-section description is not a new scope expansion.
- Preserve Stage 1 approved-source, machine-verifiable correspondence evidence before RWA
  minting or activation in both the whole-artwork and fractional sections. It applies to
  authenticated assets and enforceable real-world rights, including approved non-registry
  sources such as custody, warehouse, and certificate evidence. Preserve applicable ERC-8415
  identity, restriction, and lifecycle requirements, plus registry synchronization where the
  asset is registry-backed. Charity NFT independence is not a general exemption for fractions.
- The external mirror's read-only execution boundary applies to that integration. It does
  not prohibit ArtFi's own whole-artwork or fractional order book, matching, or settlement.
- Keep approved external adapters and venue links. Neither primary-venue wording nor a
  change in the business rollout retires compatible integration code without authorization.

### 1.2 Assets and authority

- The registry of record determines recorded holdership within its scope; the chain
  determines token state and settlement; ArtFi stores are read-only projections.
- On divergence, show the sources and their different claims. Never resolve a property
  question from ArtFi's database or silently equate token transfer with registry transfer.
- Registry authority belongs to the source role, not to ArtCCH as platform operator.
  ArtFi consumes registries and does not become a registry in this application.
- Disclose own-account sales, but grant ArtCCH no seller, matching, fee, visibility,
  settlement, or administrative property privilege.
- Fixed-price and order-book trading use the existing valid signed intents and atomic
  settlement. No resting custody is introduced. Preserve bounded partial fills and
  revocation, expiry, quantity, replay, and signature checks.
- Keep the existing auction escrow exception, bounded by its accepted terms and with
  settlement, credit withdrawal, and the required seller escape available during pause.
- Governance rights follow the actual asset structure; token possession does not create
  unspecified economic, voting, or physical rights.

### 1.3 Application and ecosystem

ArtFi is a commercial application, not a demo, an ERC8415-Kit repository, an Oracle implementation,
or the independent wallet product. Its application-side integrations remain in scope. Complete
only the interfaces actually needed by the current workflow; do not import every external
product milestone as a prerequisite.

Stage 2 NO-HIL capability remains the cumulative scope incorporated by #110. Preserve its
A1–A10 capabilities, A0–A6 acceptance, authority separation, deterministic policy, RWA grounding,
key safety, autonomous recovery, and partner neutrality. Do not retroactively require full
Stage 2 operation or soak evidence for an otherwise independent Stage 1 delivery.

Keep infrastructure and registry partners neutral and pluggable. CCHS and OpenSea are the
client-specified business and marketplace references, not architectural privileges. Authorized
real deployment bindings remain isolated in `docs/DEPLOYMENT_ENVIRONMENT.md` and removable.
The established delivery/database zone and SIN chain-execution zone remain distinct.
`<LLM_PROVIDER_A>` is replaceable; model output is advisory and never transaction authority.

## 2. Traceability and evidence

For a product change, identify the applicable #110 provision or explicit later client instruction.
For a finding, record separately:

1. Baseline: the requirement that applies.
2. Evidence: exact file, test, CI run, transaction and receipt, or observed runtime behavior.
3. Finding: the specific mismatch and the function affected.

If a requirement trace is absent, label the observation as a recommendation or question. Do not
turn it into a blocking acceptance condition.

`docs/STATUS.md` records evidence and the existing six status values. It creates no scope.
Do not promote completion from code presence, a self-assessment, stale test counts, another
commit's results, a screenshot alone, or fixture data presented as live. Record unrun checks.

Historical checkpoints are historical evidence, not a current stage declaration. In particular,
the 2026-09-20 S-XM/PR #114 checkpoint and its test counts in earlier revisions of this file must
not be applied to a changed head. Consult current code, CI, and `docs/STATUS.md` for present state.

## 3. Bounded working delivery

For each stage:

1. Identify a finite set of existing requirements and the applicable environment.
2. Finish, test, integrate, and demonstrate that set through real desktop and mobile screens.
3. Record remaining valid work in its appropriate stage.
4. Pull later work forward only when an evidenced technical dependency makes it necessary.
5. Do not add scope during implementation without an explicit client instruction.

The working priority is to finish useful existing work, close a bounded stage, demonstrate it,
and proceed. Neither architecture review nor cleanup may indefinitely displace working delivery.

The current three-section web delivery is to `io.artcch.com`. A requested web deployment is not
equivalent to mainnet contract deployment, real-asset opening, or final complete-market production
acceptance. Perform the authorized web build and deployment needed for the requested delivery;
do not use the final-production-last rule to avoid it.

The existing S-CH, S-XM, S-WA, S-FR, S-OPS, and S-MKT labels group requirements only. They add no
gate, status, or requirement denominator. Only the complete market has the complete end-state
handover. A stage does not inherit unrelated mainnet, 48-hour final stability, all-partner,
independent-wallet-complete, or Stage 2 autonomous-operation conditions.

Business opening conditions retain their proper scope. Real charity evidence applies to the
real release; whole-artwork opening uses its applicable Oracle, wallet, and registry path;
fractional commercial opening retains the client-side compliance condition. None prohibits
building and verifying independent functions with the approved test payload.

A stage is verified on function. Preserve valid existing interaction patterns. Missing prototype
reference images or a pending Figma redesign affect their specific visual comparison, not all
functional delivery. Rights disclosures, file access controls, preview restrictions, and
fail-closed behavior remain functional requirements.

## 4. Standing engineering rules

- Preserve useful compatible code, tests, security fixes, and infrastructure regardless of
  who wrote them. Do not rebuild working surfaces without a product reason or verified defect.
- Keep changes bounded and reviewable. Run the applicable tests and final integration checks;
  do not treat a focused test as a complete pass.
- Fixtures and static examples must remain visibly distinct from live product data.
- A blocker must name the exact current-stage function it prevents and the evidence for that
  dependency. Unknown or later-stage work is not a blocker by default.
- Resolve technical questions from existing requirements and implementation evidence. Where
  unspecified, choose the least-expansive reversible implementation and record the choice.
- Ask the client only for an actual product/commercial decision or input their side must
  supply, such as a missing asset, environment, credential, or channel. Do not refer ordinary
  engineering choices upward as approval requirements.
- Distinguish required missing inputs, product decisions, and technical defects. Continue
  unaffected work instead of turning one unavailable dependency into a project-wide stop.
- Follow the actual authorization and tool-safety rules for consequential actions. Product
  goals, a green test, or an agent-authored acceptance sentence do not create execution authority.

## 5. Hard safety and data boundaries

- No private keys, seed phrases, credentials, database dumps, or raw signed transactions in
  ArtFi web/API storage, databases, GitHub, CI, logs, or other prohibited surfaces. Use only
  approved secret-handling and signing paths; never log or publish sensitive values.
- Mainnet, real assets, and real-money operation require the applicable written authority.
  Historical automatic-promotion wording conflicts with the separate-approval wording in
  the repository. Do not infer permission from that conflict; report the exact action to
  the delivery owner and follow the applicable execution rules.
- The current write-testing chain is Hoodi `560048`; it does not select the production chain.
- Isolated Hoodi assets are TEST_ONLY. Real CCHS/ArtCCH documents are not prerequisites for
  their technical testing. Keep those fixtures separate from real donation, receipt,
  valuation, holder-benefit, production, and mainnet records.
- Preserve immutable historical mint evidence, including the distinct Sepolia records.
- Protect charity masters, enforce CH.7 and CH.11 preview restrictions, and release only the
  authorized distinct watermarked holder file after wallet ownership verification.
- External-source names and infrastructure bindings follow the established neutrality policy.
- LLM output is advisory. User, operational, and constitutional authorities remain distinct.
  No operational agent infers higher authority from lower authority.

## 6. Cleanup without scope loss

Classify disputed requirements or implementation into the existing four buckets:

| Bucket       | Treatment                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| KEEP         | Preserve useful compatible implementation and valid evidence                                                                          |
| FINISH-NOW   | Complete existing requirements needed by the bounded current stage                                                                    |
| FREEZE-LATER | Preserve compatible later-stage work without expanding the current stage                                                              |
| REMOVE       | Remove unsupported governance or demonstrably harmful, contradictory, dead, or security-sensitive implementation with a stated reason |

Governance rollback is not code rollback. Provenance alone is never a reason to delete useful
implementation. Do not retain an invalid obligation because effort was spent on it, and do not
invent replacement obligations while removing it. State the valid replacement source, if any,
for each removal. No fifth bucket of agent-created requirements is allowed.

## 7. Before handover

Confirm that:

- The changed behavior follows the three-section definition and its inherited requirements.
- NFT venue preference has not disabled RWA or fractional trading.
- The whole-artwork token remains a receipt/voucher and chain state remains distinct from registry rights.
- Charity functionality, inherited fractional/DAO functions, and applicable ERC-8415 controls remain present.
- No new scope, gate, status, blanket exemption, or client obligation was introduced.
- The finite delivered workflows are reachable and operable from the UI in their actual environment.
- Applicable tests, integration checks, and current-head CI evidence are recorded accurately.
- `docs/STATUS.md` records what was verified and what remains; it does not claim unrun production or mainnet checks.
- Unresolved product decisions and missing inputs are identified without blocking unrelated work.

Deliver bounded working stages and preserve the existing product. Do not turn ArtFi into an
indefinitely expanding pre-delivery project.

## CTYun TCP port 443 reservation

On CTYun hosts, TCP port 443 is reserved for SSH. Do not configure HTTP, HTTPS, web servers, reverse proxies, or TLS listeners to bind to TCP port 443. Do not stop, rebind, replace, or otherwise disrupt SSH to free that port.

Before selecting a web or bridge port, inspect the existing deployment and operations configuration and reuse an explicitly confirmed allocation. Do not guess a replacement port. If the allocation is unclear, report the missing configuration rather than changing a service binding.

This constraint applies only to CTYun hosts; do not extend it to SIN or other environments without an explicit instruction. Recording this rule does not authorize server access or changes to SSH, firewalls, credentials, network settings, or security settings.
