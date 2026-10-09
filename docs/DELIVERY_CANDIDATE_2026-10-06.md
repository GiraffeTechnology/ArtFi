# Native application delivery candidate — 2026-10-06

Status: `IMPLEMENTED-NOT-VERIFIED`. This is an integrated engineering candidate,
not complete-market acceptance, a mainnet release, or authority to operate real
assets. Product scope remains issue #110, incorporated #84, the later client
instructions, and the current `PRD.md`.

## Implemented application paths

- Digital NFTs: native official OpenSea discovery, exact order review, listings,
  purchases, offers, acceptance, eligible cancellation, durable unsigned operation
  records, private holdings/history, and explicit reconciliation. Source references
  remain data and the optional external OpenSea website link remains in the footer.
- Whole receipts: persisted source-backed asset catalog, independent source/registry
  and chain facts, Oracle temporal projection, and signed whole-token trading with
  individual and epoch-wide owner revocation. A token transfer does not prove
  physical delivery or registry transfer.
- Fractions and DAO: the inherited creation, NFT selection, approval, deposit,
  issuance and governance paths; price-time matching, partial fills and deliberate
  revoke-before-replacement amendments; auctions and owner recovery paths.
- Account functions: authenticated holdings, exact applicable FIFO cost basis and
  P&L, explicit unknown valuation/basis, wallet-scoped event notifications, system
  notices, and delivery preferences.
- Application administration: private reports/appeals, scoped moderation decisions,
  idempotent revisions and durable audit events. The moderator role grants no
  asset, source, registrar or settlement authority.
- Existing operator multisig: exact zero-value creation calls for RWA, Vault and
  charity contracts; independently confirmed proposals, chain-time timelocks,
  execution and recovery, with original recipient and issuance identities retained.
- Approved-source publication and mint preparation: independently signed public
  evidence, immutable identity bindings, revocation and validity checks, ordinary
  wallet-authenticated catalog activation, and evidence renewal on the original
  prepared issuance. No source signing key enters the application.
- M6 operations: fixed-pool Nginx configuration, live cross-instance operation
  persistence, primary readiness, JSON service logs, bounded read-only alerts,
  MySQL primary/replica templates, consistent backups and verified empty-target
  restore. These are reusable tools with isolated integration evidence; production
  cluster activation and destinations remain separate deployment work.
- Stage 2 application modules: bounded action policy, durable intent/workflow
  ledgers, outcome verification, deterministic recovery and planner fallback,
  constrained observation/provider selection and private runtime history. A
  synthetic execution provider does not complete the missing real delegated
  authority integration or establish NO-HIL operation.

The catalog's TEST_ONLY records are explicitly synthetic. They do not represent
real property, legal entitlement, donations, receipts or production deployments.
Native issuance grounding acceptance and independent review remain incomplete;
this candidate does not claim those acceptance items have passed.

## Installation deliverable

[INSTALLATION.md](INSTALLATION.md) describes the precompiled Linux web/API/mirror
runtimes, bundled Node, optional bounded runtime and monitor, all MySQL migrations,
configuration validator, integrity checks, process/service templates, upgrade and
application rollback. Source-matching Solidity 0.8.30 ABI/bytecode and reusable
artifact-first acceptance tools are also included. Installation
requires no Node package download, Go compiler, source checkout or onsite assembly.
MySQL and optional external services remain operator-supplied infrastructure.

Each built archive carries a source-file manifest, explicit dirty-source marker,
runtime versions and checksum sidecar. A working-tree base revision must not be
misrepresented as a published commit containing its edits. Exact-head CI and a
published source revision remain pending until an authorized publication and
successful workflow run actually occur.

Supporting implementation boundaries:

- [Source grounding and renewal](RWA_SOURCE_GROUNDING.md)
- [Fraction matching and amendment](FRACTION_MATCHING.md)
- [Portfolio performance and notifications](PORTFOLIO_PERFORMANCE.md)
- [Moderation and appeals](ADMIN_MODERATION.md)
- [Multisignature operator flows](ADMIN_SAFE_WORKFLOW.md)
- [Cluster and monitoring operations](CLUSTER_OPERATIONS.md)
- [MySQL primary/replica, backup and restore](MYSQL_RECOVERY.md)
- [Artifact-first lifecycle acceptance](INSTALLABLE_ACCEPTANCE.md)
- [Scoped performance measurement](PERFORMANCE_CHECKS.md)
- [Stage 2 requirement-to-evidence map](../scripts/agent/STAGE2_SCOPE.md)
- [Bounded runtime configuration and interfaces](../apps/agent-runtime/README.md)

## Reproducible verification

The existing `quality` workflow retains its normal required checks and includes
real disposable MySQL/Redis integration, browser workflows, multisig UI tests and
an installable-bundle build, bounded-runtime MySQL testing, and isolated operations
recovery jobs. New Docker wrappers are not claimed to have run in an executor
without Docker; the final receipt must identify their actual hosted result.
No hosted-CI exemption is introduced.

Local unit, contract, database and browser evidence is recorded per source
snapshot. Fixture-backed wallet/RPC checks establish only the stated isolated
application behavior. The final delivery receipt must identify the exact archive
hash and source fingerprint, and list passed, failed and not-run checks separately.
It must not aggregate results from changed snapshots into a fictional unified pass.

The optional `ARTFI_E2E_BUNDLE_ROOT` test setting runs ordinary browser suites
against the precompiled standalone runtime instead of a source development server.
It does not enable live chain access or replace required current-source CI.

## Remaining inherited work and external inputs

- Exact-head GitHub CI, publication and authorized deployment of this candidate.
- Production TLS/proxy/listener allocations, protected service configuration,
  live venue access and independently reviewed contract/source bindings.
- Full independent security review and any applicable external audit; no formal
  audit, penetration-test completion or real-value acceptance is claimed.
- Production clustered operating acceptance. Local two-node application and proxy
  tests, real MySQL replication and backup/restore results do not establish a
  deployed high-availability service or an unrun continuous soak.
- The concrete real Stage 2 delegated-authority, execution/proof/receipt adapter.
  The current independent wallet requires owner confirmation for each supported
  action and does not expose a NO-HIL delegated execution interface. This is a
  genuine capability/integration-code gap, not merely a missing production key.
  Parameterized application policy and storage can be reused, but a synthetic
  provider or an unavailable production binding must not be reported as delivery
  of real autonomous execution. Existing user-confirmed ArtFi workflows remain
  the supported execution path.
- Legacy populated databases without a migration ledger need an explicitly
  verified baseline/restore plan; the installer does not guess their schema
  history or replay initial migrations over existing data.
- Applicable production alert routing, stability/soak and real charity release
  evidence, without using those inputs to replace ordinary synthetic testing.

These items remain within their inherited scope. They are not newly invented
requirements, removed scope, or a claim that partial evidence completes the PRD.
